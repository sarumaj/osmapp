FROM python:3.14-slim AS builder

ENV PIP_ONLY_BINARY=:all: \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY pyproject.toml .
COPY LICENSE .
COPY src/ src/

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
