---
title: Install
description: Download and verify the ByteBureau binary.
---

ByteBureau ships as one executable per platform. Download the asset for your system from the [latest release](https://github.com/misaon/byte-bureau/releases/latest), make it executable and run it:

```bash
chmod +x bytebureau-*
./bytebureau-* --version
```

Verify the download with the provenance attestation GitHub generated for it:

```bash
gh attestation verify bytebureau-* --owner misaon
```

Supported targets: macOS (arm64, x64), Linux glibc and musl (x64, arm64, including Raspberry Pi 5), Windows (x64, arm64).
