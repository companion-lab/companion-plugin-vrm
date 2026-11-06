# companion-plugin-vrm

VRM avatar models (with the built-in demo asset), motion and emotion clips, and graphics settings.

One of the official feature plugins for **Companion**, a plugin-based desktop
companion app (Tauri + React). A plugin is a `manifest.json` plus an optional
bundled React frontend and an optional Rust cdylib backend; see the
companion-tauri repository (`app/PLUGINS.md`) for the full plugin format and
host API documentation.

## Layout

| Path | Contents |
|---|---|
| `manifest.json` | Plugin metadata: id, ABI version, permissions, entry points |
| `src/` | React frontend source (bundled with esbuild at build time) |
| `backend/` | Rust cdylib backend (asset serving + graphics settings) |
| `assets/model/` | Built-in demo VRM asset (committed) |
| `scripts/` | Asset inspection tools (`inspect-bones.mjs`, `vrma-bake-check.mjs`) |
| `sdk/js/@companion/plugin` | Vendored frontend SDK (`@companion/plugin`) |
| `sdk/rust/companion-plugin-sdk` | Vendored backend SDK crate (ABI, host bridge) |

React is never bundled into the plugin: `react` / `react-dom` are aliased to
the host's copies at build time, so plugin frontends always match the app.

## Building

The `companion-plugin` CLI from the companion-tauri repo bundles the frontend
(and builds the Rust backend when present) into a zip importable via the app's
**Settings → Plugins → Import plugin…**:

```bash
node /path/to/companion-tauri/plugin-cli/bin/companion-plugin.mjs build /path/to/companion-plugin-vrm \
  --backend --sdk /path/to/companion-plugin-vrm/sdk/js/@companion/plugin
```

Install dependencies first if you use a package manager lockfile
(`pnpm install` / `npm install`).
