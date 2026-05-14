# Hugging Face Spaces Docker for the drug-interaction backend.
# HF Spaces expects the app to listen on port 7860.

FROM node:20-slim

WORKDIR /app

# Install backend deps first (cached layer)
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

# Copy backend source only (data downloaded at runtime from HF Dataset)
COPY backend/ ./backend/

# HF Spaces uses 7860
ENV PORT=7860
EXPOSE 7860

# Data dir — populated at startup by ensureData()
ENV DATA_DIR=/app/data

WORKDIR /app/backend
CMD ["node", "server.js"]
