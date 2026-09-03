FROM --platform=$BUILDPLATFORM node:24-slim AS vendor

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY scripts/ ./scripts/
COPY src/osmapp/templates/ ./src/osmapp/templates/
COPY src/osmapp/static/js/ ./src/osmapp/static/js/
COPY src/osmapp/static/css/ ./src/osmapp/static/css/

RUN npm run build

FROM python:3.14-slim AS builder

ENV PIP_ONLY_BINARY=:all: \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY pyproject.toml .
COPY LICENSE .
COPY src/ src/
COPY --from=vendor /build/src/osmapp/static/vendor/ src/osmapp/static/vendor/
# Present here and absent from a plain checkout, which is what decides whether
# the page loads one bundle or the individual sources.
COPY --from=vendor /build/src/osmapp/static/dist/ src/osmapp/static/dist/
COPY --from=vendor /build/src/osmapp/static/version.json src/osmapp/static/version.json

RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --upgrade pip && \
    /opt/venv/bin/pip install .

FROM python:3.14-slim AS runtime

RUN useradd --create-home --uid 10001 osmapp && \
    mkdir -p /var/cache/osmapp/tiles && \
    chown -R osmapp:osmapp /var/cache/osmapp

COPY --from=builder /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH" \
    TILE_CACHE_DIR=/var/cache/osmapp/tiles \
    PYTHONUNBUFFERED=1

USER osmapp

WORKDIR /home/osmapp

EXPOSE ${PORT:-5000}

CMD ["osmapp"]
