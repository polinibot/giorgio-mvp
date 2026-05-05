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

# Copia codice
COPY . .

# Crea directory storage
RUN mkdir -p storage/photos

# Add non-root user
RUN useradd -m -u 1000 app
RUN chown -R app:app /app
USER app

# Espone porta
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Comando avvio
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
