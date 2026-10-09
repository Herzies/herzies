// What `cloudflare:workers` `exports` holds in tests: the Worker itself.
declare namespace Cloudflare {
  interface Exports {
    default: Fetcher;
  }
}
