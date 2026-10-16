# portal-services

Independent REST services for [Pocket Network](https://pocket.network) (Shannon), built and operated by TheFeloniousMonk and offered to agents through the Pocket agent portal. Each one is a backend that a supplier runs behind the HA RelayMiner, plus the metadata card registered on chain.

**Not a Pocket Network Foundation project.** These services are maintained personally by TheFeloniousMonk. PNF does not operate, review, or support them. Report problems here, in this repository's issues.

## Services

| Folder | Service ID | What it does | Image |
|---|---|---|---|
| [`infinifi/`](infinifi/) | `infinifi` | Read-only infiniFi protocol and wallet data for agents | `ghcr.io/thefeloniousmonk/infinifi` |
| [`meme-watch/`](meme-watch/) | `meme-watch` | Rolling 60-minute feed of Solana memecoin launches (DexPaprika) | `ghcr.io/thefeloniousmonk/meme-watch` |
| [`pretty-charts/`](pretty-charts/) | `pretty-charts` | Inline data plus a chart spec in, SVG or an HTML document out (Vega-Lite) | `ghcr.io/thefeloniousmonk/pretty-charts` |
| [`pump-check/`](pump-check/) | `pump-check` | Memecoin risk checks on Solana, Base and Robinhood Chain: on-chain facts at a named block, a simulated buy and sell, one verdict | `ghcr.io/thefeloniousmonk/pump-check` |
| [`taint-check/`](taint-check/) | `taint-check` | Dependency manifest in, known-vulnerable and confirmed-malicious packages out (OSV.dev) | `ghcr.io/thefeloniousmonk/taint-check` |

Meadow, the agent messaging node, is also mine but lives in its own repository: [TheFeloniousMonk/meadow-node](https://github.com/TheFeloniousMonk/meadow-node).

Each service's own README covers what it does, its endpoints, its settings, and anything a supplier must provide (for example, Meme Watch needs each supplier's own DexPaprika key).

## Supplying a service

Every service folder has the same layout:

| Path | What it is |
|---|---|
| `card.json` | The service card as registered on chain |
| `service.json` | Registration and deployment record, written by the Pocket Service Manager |
| `backend/` | Source, `Dockerfile`, and an offline smoke test (`npm test`) |
| `deploy/docker-compose.yaml` | Starts only the backend, on the supplier stack's `pocket-supplier` network |
| `deploy/relayer-service.yaml` | The service's block for the HA relayer config |
| `deploy/add-to-relayer.sh` | Merges that block into a relayer config and restarts the relayer |
| `deploy/rendered/` | Stake configs, SAGE entry, and health-check entry rendered by the Pocket Service Builder Skill |

To run a backend, either build it from `backend/` (what `deploy/docker-compose.yaml` does) or pull the published image. Images are tagged with the version the backend reports at `GET /v1/version`:

```bash
docker pull ghcr.io/thefeloniousmonk/taint-check:1.1.0
```

Each card's `serving.implementations` names the minimum version a supplier must run. Please keep up with it; an older backend can reject requests that newer callers send.

Every response from every service is a JSON object, including errors, as Pocket's gateways require.

## Working with the Pocket Service Manager

The Pocket Service Manager (PSM4Win) reads one services folder. Point its Settings at a clone of this repository. To manage Meadow from the same app, clone `meadow-node` into this folder as `meadow-node/`; `.gitignore` keeps it out of this repository.

## Docs site

Each card's `docs`, `serving.docs` and `specs[0].url` point at [agentdata.network](https://agentdata.network). [`site/build.mjs`](site/build.mjs) builds those pages from every service's README, card and `backend/openapi.json`, and the `site` workflow publishes them to GitHub Pages on every push to `main`. To preview locally, run `npm ci && node build.mjs` in `site/`, then serve `site/dist/`.

## Tooling

The services were built with the Pocket Service Builder Skill, which also provides the backend linter (`scripts/lint_backend.py`) and card validator mentioned in the service READMEs. It is published at [pokt-network/pocket-network-resources](https://github.com/pokt-network/pocket-network-resources/tree/main/service-builder).

## License

MIT. See [LICENSE](LICENSE).
