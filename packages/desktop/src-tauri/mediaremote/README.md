# MediaRemote adapter (macOS)

Bundled [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter) (BSD 3-Clause).

Apple blocks direct `MediaRemote.framework` access from third-party apps on macOS 15.4+.
This helper runs via `/usr/bin/perl` (privileged platform binary) and returns now-playing JSON.

To rebuild the framework from source:

```bash
git clone https://github.com/ungive/mediaremote-adapter.git
cd mediaremote-adapter && mkdir build && cd build && cmake .. && cmake --build .
cp -R MediaRemoteAdapter.framework /path/to/herzies/packages/desktop/src-tauri/mediaremote/
cp ../bin/mediaremote-adapter.pl /path/to/herzies/packages/desktop/src-tauri/mediaremote/
```

Release builds copy the Perl script into `Resources/mediaremote/` and the framework into
`Contents/Frameworks/` (via `bundle.macOS.frameworks`) so Tauri code-signs the Mach-O
binary before notarization.
