FROM nginx:alpine

# Install gettext for envsubst (replaces ${BACKEND_URL} in nginx.conf at runtime)
RUN apk add --no-cache gettext

# Copy static assets
COPY index.html /usr/share/nginx/html/
COPY verify.html /usr/share/nginx/html/
COPY style.css /usr/share/nginx/html/
COPY app.js /usr/share/nginx/html/

# Copy nginx template (uses ${BACKEND_URL} placeholder)
COPY nginx.conf /etc/nginx/templates/default.conf.template

EXPOSE 80

# nginx:alpine's official image auto-runs envsubst on /etc/nginx/templates/*.template
# and writes the result to /etc/nginx/conf.d/ before nginx starts.
# So BACKEND_URL env var is all that's needed at deploy time.
CMD ["nginx", "-g", "daemon off;"]
