// Peer sync between PumpCheck nodes, wired together: the node key, the peer
// set (from the chain, plus PUMP_PEERS), the peer API on its own port, and
// the puller. See api.js for the routes and sync.js for what is shared.

import { fromB64u, b64u, newSeed, nodeFromSeed } from "./crypto.js";
import { Peers } from "./peers.js";
import { Discovery } from "./discovery.js";
import { listSuppliers } from "./chain.js";
import { createPeerServer } from "./api.js";
import { PeerSync } from "./sync.js";

export function buildPeer({ store, evm, holderIndex, config, fetch = globalThis.fetch, listSuppliersImpl = listSuppliers, log = console }) {
  const node = nodeFromSeed(fromB64u(store.nodeSeed(() => b64u(newSeed()))));
  const peers = new Peers(Peers.parse(config.peers), { log });
  const discovery = new Discovery(node, peers, {
    networks: config.peerNetworks,
    intervalMs: config.peerDiscoveryIntervalMs,
    fetch,
    log,
    listSuppliers: (network) => listSuppliersImpl(network, { fetch }),
  });
  const server = createPeerServer({ store, holderIndex, node, peers, config, onUnknownPeer: (id) => discovery.nudge(id) });
  const sync = new PeerSync({ store, evm, holderIndex, peers, node, config, fetch, log });
  return {
    node,
    peers,
    discovery,
    server,
    sync,
    start() {
      discovery.start();
      sync.start();
    },
    stop() {
      discovery.stop();
      sync.stop();
      server.close();
    },
    status() {
      return { node: node.id, peers: peers.status(), discovery: discovery.status, sync: sync.status() };
    },
  };
}
