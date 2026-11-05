# Optional self-hosted deployment: S-Way as a static site behind hardened nginx.
#   docker build -f deployment/Dockerfile -t s-way .
#   docker run --rm -p 8080:8080 --read-only --tmpfs /tmp:size=8m --cap-drop ALL \
#              --security-opt no-new-privileges --memory 128m --cpus 0.5 --pids-limit 64 s-way
# The container never receives documents: all analysis runs in the visitor's browser.
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY deployment/nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html .nojekyll /usr/share/nginx/html/
COPY assets /usr/share/nginx/html/assets
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
COPY vendor /usr/share/nginx/html/vendor
COPY models /usr/share/nginx/html/models
COPY notebooks/index.json notebooks/*.ipynb /usr/share/nginx/html/notebooks/
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/index.html || exit 1
