FROM python:3.11-slim

# Installa Tesseract OCR + dipendenze sistema per Playwright Chromium
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-ita \
    nodejs \
    npm \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# Setta working directory
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PYTHONIOENCODING=UTF-8

# Copia requirements
COPY requirements.txt .

# Installa dipendenze Python
RUN pip install --no-cache-dir -r requirements.txt

# Copia codice backend + worker YAP
COPY backend/ .
COPY automation/ ./automation

# Dipendenze Node di runtime per worker YAP (lockfile deterministico, niente dev deps)
RUN cd automation/yap && npm ci --omit=dev --no-audit --no-fund

# Installa Playwright Chromium bundled (versione compatibile con playwright 1.50, ~Chrome 132)
# Evita il chromium di sistema che causa "Target crashed" per mismatch versione CDP
ENV PLAYWRIGHT_BROWSERS_PATH=/app/ms-playwright
RUN cd automation/yap && npx playwright install chromium

# Crea directory storage (before switching user)
RUN mkdir -p storage/photos temp

# Add non-root user and set ownership
RUN useradd -m -u 1000 app && chown -R app:app /app
USER app

# Espone porta
EXPOSE 8000

# Railway uses its own healthcheck via healthcheckPath in railway.toml
# No Docker HEALTHCHECK needed

# Run API and bot under one supervisor so Railway restarts the container if either exits.
CMD ["python", "start_production.py"]
