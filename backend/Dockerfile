FROM python:3.14-slim@sha256:cae66f2ef0ec51a9891263eeee7f987dacf0a9879e8aa9353d5606e0530619a5 AS runtime

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
