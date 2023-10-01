FROM node:18@sha256:933bcfad91e9052a02bc29eb5aa29033e542afac4174f9524b79066d97b23c24
RUN apt update -y && apt install -y locales curl unzip time && rm -rf /var/lib/apt/lists/* \
	&& localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8
ENV LANG en_US.utf8
RUN mkdir -p /opt/output/ ; mkdir -p /opt/scripts
COPY ./dist/inside-docker-scripts /opt/scripts
WORKDIR /root
