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

The `web-image` branch base is the upstream `v0.0.37` tag at
`cefec32d6fc5d14f03e110ebdde534bdbcc9b62b`. The image source version comes from
the `web/<version>` release tag; it does not use a downloaded source archive or
a source checksum.

Published images support `linux/amd64` and `linux/arm64`:

```text
ghcr.io/wyrd-company/t3code-web:<T3 Code version>
ghcr.io/wyrd-company/t3code-web:latest
```

## Local build and test

```bash
docker build \
  --build-arg T3CODE_VERSION=0.0.37 \
  --tag t3code-web:0.0.37 \
  --file docker/t3code-web/Dockerfile \
  .

docker run --rm --publish 8080:80 t3code-web:0.0.37
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
`.github/workflows/`. Build and run the image before publishing a matching
`web/<new-version>` tag to `origin`.
