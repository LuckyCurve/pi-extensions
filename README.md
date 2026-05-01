# Pi Extensions

Personal extensions for [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) — a collection of productivity and security enhancements that integrate directly into the pi agent runtime.

## Extensions

| Extension | Description | Version |
|-----------|-------------|---------|
| [🔐 Permission](./permission/) | Layered permission control for bash/write commands | 1.0.2 |
| [⚡ Token Rate](./token-rate/) | Real-time TPS indicator in the status bar | 1.0.2 |

## Quick Start

### Install All Extensions

```bash
# Clone the repository
git clone https://github.com/user/pi-extensions.git
cd pi-extensions

# Install dependencies
npm install

# Enable via pi config
pi config
```

### Install Individual Extensions

Each extension is also published as a standalone npm package and can be installed individually:

```bash
pi install npm:permission-pi    # Permission control
pi install npm:token-rate-pi    # Token rate status
```

Dependencies are resolved and installed automatically during `pi install`.

## Architecture

```
pi-extensions/
├── package.json              # Root package — declares both extensions
├── permission/               # Permission extension
│   ├── permission.ts         # Extension entry point, state management, handlers
│   ├── permission-core.ts    # Core logic — command classification, config, settings
│   ├── tests/                # Test suite (1400+ lines of classification tests)
│   ├── package.json          # Standalone package (permission-pi)
│   └── README.md             # Detailed documentation
└── token-rate/               # Token rate extension
    ├── token-rate.ts         # Extension entry point + status rendering
    ├── package.json          # Standalone package (token-rate-pi)
    └── README.md             # Detailed documentation
```

Each extension follows the pi extension convention:
- Entry point is a TypeScript file exporting a default function that receives the `ExtensionAPI`
- Declared in `package.json` under the `"pi"."extensions"` field
- Can be loaded from `~/.pi/agent/extensions/`, `.pi/extensions/`, or installed as an npm package

## Development

### Prerequisites

- Node.js ≥ 18
- TypeScript ≥ 5.0
- pi-coding-agent ≥ 0.50.0

### Running Tests

```bash
# Permission extension tests
cd permission && npm test

# Token rate extension (no tests yet)
cd token-rate && npm test
```

### Type Checking

```bash
npx tsc --noEmit
```

## Documentation

- **[README.md](./README.md)** — Quick start, installation, and overview
- **[AGENTS.md](./AGENTS.md)** — Full architecture, implementation details, and contributor guide

## License

MIT
