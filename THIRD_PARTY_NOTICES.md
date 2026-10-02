# Third-party notices

Solidity Flowboard 1.2.0 by Zurab Anchabadze is redistributed **unmodified** in the installation ZIP. The upstream package includes its MIT license at `extension/LICENSE.txt`. Project listing: https://open-vsx.org/extension/anchabadze/solidity-flowboard

Pinned VSIX SHA-256: `de98a6cfe43cd441ab1e06d818c5a082ebba79c7224ece2176506f7162a19c13`.

The companion's `extension/webview/inline-review.js` line mapper adapts the pinned upstream comment-filter semantics to retain original source coordinates. That adaptation retains the upstream MIT attribution below; the redistributed upstream VSIX itself is unchanged.

Upstream license:

MIT License

Copyright (c) 2026 Zurab Anchabadze

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Flowboard Triage invokes upstream's installed runner/panel through a pinned, module-local adapter. It does not modify upstream's installed files. Python's Slither analyzer is an optional separately installed dependency; its sources/binaries are not bundled here. See its own licensing before redistributing Python environments.
