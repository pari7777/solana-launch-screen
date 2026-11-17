FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 TZ=Asia/Kolkata
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
# own AI: CPU-only PyTorch (small, no GPU needed) + FinBERT, downloaded once at build time so start-up needs no internet
ENV HF_HOME=/app/hf
COPY requirements-ai.txt .
RUN pip install torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu && pip install -r requirements-ai.txt \
 && python -c "from transformers import pipeline; pipeline('text-classification', model='ProsusAI/finbert')"
COPY app ./app
COPY config ./config
COPY migrations ./migrations
COPY scripts ./scripts
RUN useradd -m bot && mkdir -p /app/data && chown -R bot /app
USER bot
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/health')"
CMD ["python", "-m", "app.main"]
