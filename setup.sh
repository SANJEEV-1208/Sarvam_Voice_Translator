#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🚀 Sarvam Live Translator - Docker Setup"
echo "========================================="

# Check if .env file exists in project folder
if [ ! -f project/.env ]; then
    echo -e "${RED}❌ project/.env file not found!${NC}"
    echo -e "${YELLOW}Please create project/.env file with your SARVAM_API_KEY${NC}"
    echo "Example:"
    echo "  SARVAM_API_KEY=your_api_key_here"
    echo "  PORT=3000"
    exit 1
fi

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed!${NC}"
    echo "Please install Docker first: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if Docker is running
if ! docker info &> /dev/null; then
    echo -e "${RED}❌ Docker is not running!${NC}"
    echo "Please start Docker first"
    exit 1
fi

# Check if docker-compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo -e "${YELLOW}⚠️ docker-compose not found, using docker commands${NC}"
    USE_COMPOSE=false
else
    USE_COMPOSE=true
fi

# Stop and remove existing container if running
if [ "$(docker ps -aq -f name=sarvam-translator)" ]; then
    echo -e "${YELLOW}🔄 Removing existing container...${NC}"
    docker stop sarvam-translator 2>/dev/null
    docker rm sarvam-translator 2>/dev/null
fi

# Build and run
if [ "$USE_COMPOSE" = true ]; then
    echo -e "${GREEN}📦 Building and starting with docker-compose...${NC}"
    docker-compose up -d --build
    echo -e "${GREEN}✅ Container started!${NC}"
    echo -e "📊 To view logs: ${YELLOW}docker-compose logs -f${NC}"
    echo -e "🛑 To stop: ${YELLOW}docker-compose down${NC}"
else
    echo -e "${GREEN}📦 Building Docker image...${NC}"
    docker build -t sarvam-translator .
    
    echo -e "${GREEN}🚀 Starting container...${NC}"
    docker run -d \
        --name sarvam-translator \
        -p 3000:3000 \
        --env-file project/.env \
        --restart unless-stopped \
        sarvam-translator
    
    echo -e "${GREEN}✅ Container started!${NC}"
    echo -e "📊 To view logs: ${YELLOW}docker logs -f sarvam-translator${NC}"
    echo -e "🛑 To stop: ${YELLOW}docker stop sarvam-translator${NC}"
    echo -e "🧹 To remove: ${YELLOW}docker rm sarvam-translator${NC}"
fi

echo ""
echo -e "${GREEN}🌐 Application available at: http://localhost:3000${NC}"
echo ""
echo "📝 Notes:"
echo "  - Meeting links expire after 1 hour (IST timezone)"
echo "  - Voice settings are configured by the sales rep (30+ voices)"
echo "  - Client name field is available for personalization"
echo "  - Client sees 'Meeting Ended' screen (not rep dashboard)"
echo ""
echo "🐳 Docker commands:"
echo "  - View logs: docker logs -f sarvam-translator"
echo "  - Enter container: docker exec -it sarvam-translator sh"
echo "  - Check status: docker ps"