# @moonshot-ai/kosong

## 0.2.0

### Minor Changes

- [#30](https://github.com/MoonshotAI/kimi-code/pull/30) [`a200a29`](https://github.com/MoonshotAI/kimi-code/commit/a200a297ac8986ec4baa8d2cdc881ef71bc3abfc) - Add a `/connect` command that configures a provider and model from a model catalog. By default it reads from a pruned catalog snapshot bundled with the CLI, so the command works offline and is not gated by models.dev availability. Model metadata (context window, output limit, and capabilities) is filled in automatically, so models no longer need to be written by hand in config. Pass `--refresh` to fetch the latest catalog from models.dev (falling back to the bundled snapshot on failure), or `--url` to point at a custom catalog endpoint that uses the same format. When connecting an Anthropic-compatible provider whose catalog base URL already includes a version segment, the request path no longer duplicates that segment, so connections that previously failed with a not-found error now succeed.

- [#25](https://github.com/MoonshotAI/kimi-code/pull/25) [`c4dd1c7`](https://github.com/MoonshotAI/kimi-code/commit/c4dd1c7ff298290ee17d4a6676f93284621f32e8) - Flatten tool call data by inlining tool names and arguments at the top level, and limit legacy record migration so it only rewrites matching tool call payloads.

### Patch Changes

- [#29](https://github.com/MoonshotAI/kimi-code/pull/29) [`df7a9ca`](https://github.com/MoonshotAI/kimi-code/commit/df7a9cab606e0f152bc45b1d1645d76210b1e0c4) - Avoid CPU spikes from large streamed tool arguments and coalesce high-frequency streaming UI updates.
