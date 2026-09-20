# Loopback gateway for the Legal Archive task. The official image renders
# /etc/nginx/templates/*.template with envsubst at start (ARCHIVE_APP_KEY from
# the task secret) into /etc/nginx/conf.d/default.conf.
FROM public.ecr.aws/nginx/nginx:1.27-alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY templates/default.conf.template /etc/nginx/templates/default.conf.template
RUN rm -f /etc/nginx/conf.d/default.conf \
 && mkdir -p /tmp/client_body /tmp/proxy /tmp/fastcgi /tmp/uwsgi /tmp/scgi
# envsubst only touches ${VAR} names listed here; nginx's own $variables stay intact.
ENV NGINX_ENVSUBST_FILTER="^ARCHIVE_APP_KEY$"
EXPOSE 8781
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8781/health || exit 1
