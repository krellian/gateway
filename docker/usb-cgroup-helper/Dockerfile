FROM alpine:3.20

RUN apk add --no-cache curl jq

COPY cgroup-allow.sh /usr/local/bin/cgroup-allow.sh
RUN chmod +x /usr/local/bin/cgroup-allow.sh

ENTRYPOINT ["/usr/local/bin/cgroup-allow.sh"]
