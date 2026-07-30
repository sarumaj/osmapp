# Build stage
FROM python:3.14-slim

WORKDIR /app

# Copy project files
COPY pyproject.toml .
COPY src/ src/

# Install the project and its dependencies
RUN pip install --no-cache-dir .

# Expose the app port
EXPOSE ${PORT:-5000}

# Set the command
CMD ["python3", "-m", "osmapp"]