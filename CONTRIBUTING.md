# Contributing to OpenRouter Agent

Thanks for your interest in contributing!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/openrouter.git`
3. Install dependencies: `npm install`
4. Copy `.env.example` to `.env` and configure your API keys

## Development

- Entry point: `src/index.js`
- Core logic: `src/core/`
- Tools: `src/tools/`

## Code Style

- Use ES modules (`import`/`export`)
- Prefer `async`/`await` over raw promises
- Add JSDoc comments for public APIs
- Keep tools self-contained in their own files

## Submitting Changes

1. Create a feature branch
2. Make your changes
3. Test manually
4. Submit a pull request with a clear description

## Reporting Issues

Use the [GitHub Issues](https://github.com/af-t/openrouter/issues) page. Include:
- Node.js version
- Steps to reproduce
- Expected vs actual behavior
