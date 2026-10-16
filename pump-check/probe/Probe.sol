// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// PumpCheck's honeypot and tax probe.
//
// Never deployed. The backend places this contract's runtime code at a fixed
// address with an eth_call state override, gives the caller a balance with
// another override, and calls probe(). One call buys a small amount of the
// token through its own pool and sells everything back, and reports what
// each side actually received. Nothing is signed or broadcast; the swaps
// exist only inside that eth_call.
//
// Each leg runs through an external self-call so a revert in the token (a
// honeypot, a blacklist, a max-transaction rule) is captured as data instead
// of failing the whole call.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IUniV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface ISolidlyPair {
    function token0() external view returns (address);
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IUniV3Pool {
    function token0() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
}

contract Probe {
    uint8 internal constant KIND_UNIV2 = 1;
    uint8 internal constant KIND_SOLIDLY = 2;
    uint8 internal constant KIND_UNIV3 = 3; // Uniswap v3 and Aerodrome Slipstream share the pool interface
    uint8 internal constant KIND_UNIV4 = 4;
    uint8 internal constant KIND_PONS_CURVE = 5;

    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    struct Request {
        uint8 kind;
        address pool; // the pair or pool; for v4 the PoolManager; for Pons the curve
        address token; // the token under test
        address quote; // what it trades against; address(0) is native ETH
        address weth; // wrapped native, used when quote is WETH and the caller sent ETH
        uint256 amountIn; // quote spent on the buy
        PoolKey key; // v4 only
    }

    struct Leg {
        bool ok;
        uint256 expected; // what the pool says it sent (buy) or what the pool should pay for what arrived (sell)
        uint256 received; // what actually landed
        uint256 sent; // sell only: tokens the probe sent
        uint256 arrived; // sell only, v2-style: tokens the pair actually received
        bytes err;
    }

    // Transient context for callbacks (v3 and v4). Storage is fine: the
    // contract exists only for the length of one eth_call.
    address internal cbPool;
    address internal cbPayToken;
    PoolKey internal cbKey;
    bool internal cbZeroForOne;
    uint256 internal cbAmountIn;
    address internal cbIn;
    address internal cbOut;

    receive() external payable {}

    function probe(Request calldata r) external payable returns (Leg memory buyResult, Leg memory sellResult) {
        // Native quote arrives as msg.value; WETH quote is wrapped from it.
        if (r.quote != address(0) && r.quote == r.weth && msg.value > 0) IWETH(r.weth).deposit{value: msg.value}();

        // amountIn == 0 is a sell-only run: the caller gave this contract a token
        // balance by state override, which separates "a holder cannot sell" from
        // a token that only refuses a sell in the same block as the buy.
        if (r.amountIn == 0) {
            buyResult.ok = true;
            buyResult.received = IERC20(r.token).balanceOf(address(this));
            buyResult.expected = buyResult.received;
        } else {
            try this.buyLeg(r) returns (uint256 expected, uint256 received) {
                buyResult.ok = true;
                buyResult.expected = expected;
                buyResult.received = received;
            } catch (bytes memory err) {
                buyResult.err = err;
                return (buyResult, sellResult);
            }
        }
        if (buyResult.received == 0) return (buyResult, sellResult);

        try this.sellLeg(r) returns (uint256 sent, uint256 arrived, uint256 expected, uint256 received) {
            sellResult.ok = true;
            sellResult.sent = sent;
            sellResult.arrived = arrived;
            sellResult.expected = expected;
            sellResult.received = received;
        } catch (bytes memory err) {
            sellResult.sent = IERC20(r.token).balanceOf(address(this));
            sellResult.err = err;
        }
    }

    // ---- buy -------------------------------------------------------------

    function buyLeg(Request calldata r) external returns (uint256 expected, uint256 received) {
        require(msg.sender == address(this), "self only");
        uint256 before = IERC20(r.token).balanceOf(address(this));
        if (r.kind == KIND_UNIV2 || r.kind == KIND_SOLIDLY) {
            expected = _swapV2(r, r.quote, r.token, r.amountIn);
        } else if (r.kind == KIND_UNIV3) {
            expected = _swapV3(r.pool, r.quote, r.token, r.amountIn);
        } else if (r.kind == KIND_UNIV4) {
            expected = _swapV4(r, r.quote, r.token, r.amountIn);
        } else if (r.kind == KIND_PONS_CURVE) {
            uint256 value = r.quote == address(0) ? r.amountIn : 0;
            if (value == 0) IERC20(r.quote).approve(r.pool, r.amountIn);
            expected = IPonsCurve(r.pool).buy{value: value}(r.amountIn, 0, address(this));
        } else {
            revert("unknown kind");
        }
        received = IERC20(r.token).balanceOf(address(this)) - before;
    }

    // ---- sell ------------------------------------------------------------

    function sellLeg(Request calldata r)
        external
        returns (uint256 sent, uint256 arrived, uint256 expected, uint256 received)
    {
        require(msg.sender == address(this), "self only");
        sent = IERC20(r.token).balanceOf(address(this));
        uint256 before = _balance(r.quote);
        if (r.kind == KIND_UNIV2 || r.kind == KIND_SOLIDLY) {
            uint256 pairBefore = IERC20(r.token).balanceOf(r.pool);
            _transfer(r.token, r.pool, sent);
            arrived = IERC20(r.token).balanceOf(r.pool) - pairBefore;
            expected = _v2Out(r, r.token, arrived);
            (uint256 a0, uint256 a1) = IUniV2Pair(r.pool).token0() == r.token ? (uint256(0), expected) : (expected, uint256(0));
            IUniV2Pair(r.pool).swap(a0, a1, address(this), "");
        } else if (r.kind == KIND_UNIV3) {
            arrived = sent;
            expected = _swapV3(r.pool, r.token, r.quote, sent);
        } else if (r.kind == KIND_UNIV4) {
            arrived = sent;
            expected = _swapV4(r, r.token, r.quote, sent);
        } else if (r.kind == KIND_PONS_CURVE) {
            IERC20(r.token).approve(r.pool, sent);
            arrived = sent;
            expected = IPonsCurve(r.pool).sell(sent, 0, address(this));
        }
        received = _balance(r.quote) - before;
    }

    // ---- venues ------------------------------------------------------------

    function _swapV2(Request calldata r, address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 out) {
        _transfer(tokenIn, r.pool, amountIn);
        out = _v2Out(r, tokenIn, amountIn);
        (uint256 a0, uint256 a1) = IUniV2Pair(r.pool).token0() == tokenOut ? (out, uint256(0)) : (uint256(0), out);
        IUniV2Pair(r.pool).swap(a0, a1, address(this), "");
    }

    function _v2Out(Request calldata r, address tokenIn, uint256 amountIn) internal view returns (uint256) {
        if (r.kind == KIND_SOLIDLY) return ISolidlyPair(r.pool).getAmountOut(amountIn, tokenIn);
        (uint112 r0, uint112 r1,) = IUniV2Pair(r.pool).getReserves();
        bool inIs0 = IUniV2Pair(r.pool).token0() == tokenIn;
        (uint256 rin, uint256 rout) = inIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 withFee = amountIn * 997;
        return (withFee * rout) / (rin * 1000 + withFee);
    }

    function _swapV3(address pool, address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 out) {
        bool zeroForOne = IUniV3Pool(pool).token0() == tokenIn;
        cbPool = pool;
        cbPayToken = tokenIn;
        (int256 d0, int256 d1) = IUniV3Pool(pool).swap(
            address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE, ""
        );
        cbPool = address(0);
        out = uint256(-(zeroForOne ? d1 : d0));
        tokenOut; // the pool pays tokenOut to this contract; received is measured by the caller
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == cbPool && cbPool != address(0), "bad callback");
        uint256 pay = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        _transfer(cbPayToken, msg.sender, pay);
    }

    function _swapV4(Request calldata r, address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 out) {
        cbKey = r.key;
        cbZeroForOne = r.key.currency0 == tokenIn;
        cbAmountIn = amountIn;
        cbIn = tokenIn;
        cbOut = tokenOut;
        cbPool = r.pool;
        bytes memory res = IPoolManager(r.pool).unlock("");
        cbPool = address(0);
        out = abi.decode(res, (uint256));
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == cbPool && cbPool != address(0), "bad callback");
        IPoolManager pm = IPoolManager(msg.sender);
        int256 delta = pm.swap(
            cbKey,
            SwapParams({
                zeroForOne: cbZeroForOne,
                amountSpecified: -int256(cbAmountIn),
                sqrtPriceLimitX96: cbZeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE
            }),
            ""
        );
        // BalanceDelta packs amount0 in the upper 128 bits and amount1 in the lower.
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        (int128 dIn, int128 dOut) = cbZeroForOne ? (d0, d1) : (d1, d0);
        uint256 owe = uint256(uint128(-dIn));
        uint256 out = uint256(uint128(dOut));
        if (cbIn == address(0)) {
            pm.settle{value: owe}();
        } else {
            pm.sync(cbIn);
            _transfer(cbIn, msg.sender, owe);
            pm.settle();
        }
        pm.take(cbOut, address(this), out);
        return abi.encode(out);
    }

    // ---- helpers -------------------------------------------------------------

    function _balance(address token) internal view returns (uint256) {
        return token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    // Tolerates tokens that return nothing from transfer (USDT style).
    function _transfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }
}
