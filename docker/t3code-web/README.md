---
relationships:
  documents:
    - docker/t3code-web/Dockerfile
    - .github/workflows/fork-web-image-ci.yml
    - .github/workflows/fork-web-image-cd.yml
  references: LICENSE
---

# T3 Code web client image

This image builds the static `@t3tools/web` client from this checkout and serves
it with Nginx. It contains no T3 server, agent runtime, credentials, project
files, or relay modifications.

This branch is additive commits on one upstream release. The release is
whichever commit the branch and `main` last share, which
`.github/fork/resolve-base.sh` reports; the fork origin intentionally does not
mirror upstream `v*` tags, so nothing here resolves one. The image source
version comes from the `web/<version>` release tag; it does not use a
downloaded source archive or a source checksum.

Published images support `linux/amd64` and `linux/arm64`. The
[package page](https://github.com/wyrd-company/t3code/pkgs/container/t3code-web)
lists every published tag and its digest:

```text
ghcr.io/wyrd-company/t3code-web:latest
```

## Local build and test

`T3CODE_VERSION` is what the image calls itself: it becomes the client's
reported version and the image's OCI version label. It selects nothing — the
build compiles the checked-out tree — so a local build labels itself `dev`
rather than claiming to be a published release it does not contain.

```bash
docker build \
  --build-arg T3CODE_VERSION=dev \
  --tag t3code-web:dev \
  --file docker/t3code-web/Dockerfile \
  .

docker run --rm --publish 8080:80 t3code-web:dev
```

The browser connects directly to a separately deployed T3 server. When this
client is served over HTTPS, the server must also be reachable over HTTPS/WSS
to avoid browser mixed-content blocking.

## Rebase to an upstream release

Keep this branch additive.

```bash
git fetch upstream --tags
git switch web-image
git rebase --onto v<new-version> v<current-version> web-image
.github/fork/fork-surface.sh
```

The surface report must show only added files under `docker/t3code-web/` and
`.github/workflows/`. Nothing records the new base: it is the commit the branch
and `main` now share. After the rebase:

1. Compare `ARG VITE_PLUS_VERSION` in the Dockerfile with
   `.catalog."vite-plus"` in `pnpm-workspace.yaml` and update it when needed.
2. Build and run the image before publishing a matching `web/<new-version>` tag
   to `origin`.
