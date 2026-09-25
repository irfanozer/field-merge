FROM python:3.12-slim@sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9 AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH="/app/src" \
    PATH="/opt/venv/bin:$PATH"

RUN python -m venv /opt/venv
WORKDIR /app

COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes --requirement requirements.lock

COPY src ./src

COPY alembic.ini ./
COPY alembic ./alembic

RUN addgroup --system fieldmerge && adduser --system --ingroup fieldmerge fieldmerge \
    && chown -R fieldmerge:fieldmerge /app
USER fieldmerge

EXPOSE 8000
CMD ["uvicorn", "fieldmerge.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
