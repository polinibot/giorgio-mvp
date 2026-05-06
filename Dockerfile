FROM python:3.11-slim

# Installa Tesseract OCR
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-ita \
    && rm -rf /var/lib/apt/lists/*

# Setta working directory
WORKDIR /app

# Copia requirements
COPY requirements.txt .

# Installa dipendenze Python
RUN pip install --no-cache-dir -r requirements.txt

# Copia codice backend
COPY backend/ .

# Crea directory storage (before switching user)
RUN mkdir -p storage/photos temp

# Add non-root user and set ownership
RUN useradd -m -u 1000 app && chown -R app:app /app
USER app

# Espone porta
EXPOSE 8000

# Railway uses its own healthcheck via healthcheckPath in railway.toml
# No Docker HEALTHCHECK needed

# Comando avvio - solo uvicorn, bot non necessario per API
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "${PORT:-8000}"]