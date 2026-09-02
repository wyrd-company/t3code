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

The `web-image` branch base is the upstream `v0.0.38` tag at
`c0995d2eaf8ec787b3318ed1169ae266ed1529f8`. The fork origin intentionally
does not mirror upstream `v*` tags, so CI and CD do not resolve the tag there;
verification uses the pinned base commit for executable existence and the
additive diff. The fork release identity is
`web/0.0.38-wyrd.1`, which publishes image version `0.0.38-wyrd.1`. The image
source version comes from the `web/<version>` release tag; it does not use a
downloaded source archive or a source checksum.

Published images support `linux/amd64` and `linux/arm64`:

```text
ghcr.io/wyrd-company/t3code-web:0.0.38-wyrd.1
ghcr.io/wyrd-company/t3code-web:latest
```

## Local build and test

```bash
docker build \
  --build-arg T3CODE_VERSION=0.0.38-wyrd.1 \
  --tag t3code-web:0.0.38-wyrd.1 \
  --file docker/t3code-web/Dockerfile \
  .

docker run --rm --publish 8080:80 t3code-web:0.0.38-wyrd.1
```

The browser connects directly to a separately deployed T3 server. When this
client is served over HTTPS, the server must also be reachable over HTTPS/WSS
to avoid browser mixed-content blocking.

## Rebase to an upstream release

Keep this branch additive. Before updating the base, record the current base tag
and fetch upstream tags:

```bash
git fetch upstream --tags
git switch web-image
git rebase --onto v<new-version> v<current-version> web-image
git diff --name-status v<new-version>...HEAD
```

The final command must report only added files under `docker/t3code-web/` and
`.github/workflows/`. After the rebase:

1. Update `T3CODE_BASE_TAG`, `T3CODE_BASE_COMMIT`, and
   `T3CODE_RELEASE_VERSION` in both fork web image workflows. The release
   version identifies the fork build and can differ from the upstream base.
2. Update this README's base pin and local build example.
3. Compare `ARG VITE_PLUS_VERSION` in the Dockerfile with
   `.catalog."vite-plus"` in `pnpm-workspace.yaml` and update it when needed.
4. Build and run the image before publishing a matching `web/<new-version>` tag
   to `origin`.

CI rejects an old workflow pin, a changed upstream-authored file, or any added
file outside the web image and its two workflows.
