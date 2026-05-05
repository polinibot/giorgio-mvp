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

# Copia codice backend (file essenziali)
COPY main.py .
COPY bot.py .
COPY config.py .
COPY models.py .
COPY ocr_service.py .
COPY security.py .
COPY cloudinary_service.py .

# Crea directory storage
RUN mkdir -p storage/photos temp

# Espone porta
EXPOSE 8000

# Comando avvio
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]