```
 _                   _
| |                 (_)
| |__   ___ _ __ _____  ___  ___
| '_ \ / _ \ '__|_  / |/ _ \/ __|
| | | |  __/ |   / /| |  __/\__ \
|_| |_|\___|_|  /___|_|\___||___/
```

Your digital pet that grows by listening to music. **[herzies.app](https://www.herzies.app)**

Day-to-day work in this repo centres on the **desktop app** (macOS, Tauri): it is the main product surface we ship and extend. The other packages support it, the site and API, or older workflows.

## Packages

| Package | Description |
|---------|-------------|
| [`herzies-desktop`](packages/desktop) | macOS desktop app (Tauri); primary focus for development |
| [`@herzies/shared`](packages/shared) | Shared types and utilities |
| [`web`](packages/web) | Website, game server API, and auth |
| [`herzies`](packages/cli) | CLI application — *not prioritised for ongoing development* |

## Getting Started

Download the latest **Herzies Desktop** build for macOS from the [latest GitHub release](https://github.com/Herzies/herzies/releases/latest).

> [!IMPORTANT]
> **Beta** — Herzies Desktop is still in beta. If you run into errors or bugs, please report them as [GitHub issues](https://github.com/Herzies/herzies/issues).

## Requirements

- macOS (music detection uses AppleScript and is not yet available on Linux or Windows)

## Want to contribute?

- **Add support for other operating systems** — music detection currently relies on macOS AppleScript. Linux (e.g. MPRIS) and Windows support would be welcome.
- **Add support for more music players** — we currently detect Apple Music and Spotify, but there are plenty more out there.
