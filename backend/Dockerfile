FROM python:3.15-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928 AS runtime

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
