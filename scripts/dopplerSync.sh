#!/bin/bash

doppler setup -p "euler-lite" --config "dev"
doppler secrets download --no-file --format env > .env
doppler configure unset config
