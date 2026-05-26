# @moonshot-ai/kimi-code-sdk

## 0.2.0

### Minor Changes

- [#30](https://github.com/MoonshotAI/kimi-code/pull/30) [`a200a29`](https://github.com/MoonshotAI/kimi-code/commit/a200a297ac8986ec4baa8d2cdc881ef71bc3abfc) - Add a `/connect` command that configures a provider and model from a model catalog. By default it reads from a pruned catalog snapshot bundled with the CLI, so the command works offline and is not gated by models.dev availability. Model metadata (context window, output limit, and capabilities) is filled in automatically, so models no longer need to be written by hand in config. Pass `--refresh` to fetch the latest catalog from models.dev (falling back to the bundled snapshot on failure), or `--url` to point at a custom catalog endpoint that uses the same format. When connecting an Anthropic-compatible provider whose catalog base URL already includes a version segment, the request path no longer duplicates that segment, so connections that previously failed with a not-found error now succeed.

### Patch Changes

- [#33](https://github.com/MoonshotAI/kimi-code/pull/33) [`ab4bd09`](https://github.com/MoonshotAI/kimi-code/commit/ab4bd090825cffbd7ab656b47840b0060d6cf601) - Report the macOS product version in OAuth device information instead of the Darwin kernel version.
