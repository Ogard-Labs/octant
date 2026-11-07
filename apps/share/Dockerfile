# Build from the repository root so the workspace packages resolve:
#
#   docker build -f apps/share/Dockerfile -t octant-share .
#   docker run --rm -p 4100:4100 -p 4101:4101 \
#     -e OCTANT_SHARE_DATA_DIR=/data \
#     -e OCTANT_SHARE_PUBLIC_ORIGIN=https://share.example.com \
#     -e OCTANT_SHARE_USERCONTENT_ORIGIN=https://usercontent.example.com \
#     -e OCTANT_SHARE_ABUSE_CONTACT=abuse@example.com \
#     -v octant-share-data:/data octant-share
#
# Put a TLS-terminating reverse proxy in front of ports 4100 and 4101; the two
# origins must be https (or http on loopback) and must differ.
FROM oven/bun:1.3.14

WORKDIR /app
COPY . .
# --ignore-scripts: the share service's import graph (contracts, domain, theme)
# is pure TypeScript, so the native modules other workspaces declare (node-pty,
# better-sqlite3) are never loaded and must not be compiled in this image.
RUN bun install --production --frozen-lockfile --ignore-scripts

ENV OCTANT_SHARE_HOST=0.0.0.0 \
    OCTANT_SHARE_DATA_DIR=/data
EXPOSE 4100 4101
VOLUME /data

CMD ["bun", "apps/share/src/main.ts"]
