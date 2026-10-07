#!/bin/sh
# Builds fake-camera videos (portrait, like a phone) from the fixture images.
#   sh tests/make_videos.sh <output-dir>
# Chrome plays these clips at twice the speed they are written at, so a
# picture given 6 seconds here is in front of the "camera" for about 3.
set -e
OUT=${1:-.}; F="$(cd "$(dirname "$0")/fixtures" && pwd)"
VF="scale=720:-2,pad=720:1280:0:(oh-ih)/2:color=0xC8C8C8,fps=15,format=yuvj420p"
mk() { name=$1; hold=$2; shift 2; list="$OUT/$name.txt"; : > "$list"
  for n in "$@"; do printf "file '%s/%s.png'\nduration %s\nfile '%s/no_uld.png'\nduration 1\n" "$F" "$n" "$hold" "$F" >> "$list"; done
  printf "file '%s/no_uld.png'\n" "$F" >> "$list"
  ffmpeg -y -loglevel error -f concat -safe 0 -i "$list" -vf "$VF" -c:v mjpeg -q:v 4 -f mjpeg "$OUT/$name.mjpeg"; rm "$list"; }
mk loop 3 clean_std clean_ai pallet sugg review rej
mk three 3 clean_std clean_ai rej
mk two 4 two_ulds
mk glare 6 glare

# Pallet clips from the real reference photos (tests/pallet-photos), for tests/e2e-pallet.mjs.
# Every still is first drawn onto the same 720x1280 "phone frame", so the clip has one size and one codec.
P="$(cd "$(dirname "$0")/pallet-photos" && pwd)"; T="$OUT/pallet-stills"; mkdir -p "$T"
still() { ffmpeg -y -loglevel error -i "$1" -vf "scale=720:-2,pad=720:1280:0:(oh-ih)/2:color=0xC8C8C8" -frames:v 1 "$2"; }
still "$F/no_uld.png" "$T/blank.png"
mkp() { name=$1; shift; list="$OUT/$name.txt"; : > "$list"
  while [ $# -gt 0 ]; do
    still "$P/$1.jpg" "$T/$1.png"
    printf "file '%s/%s.png'\nduration %s\nfile '%s/blank.png'\nduration 1\n" "$T" "$1" "$2" "$T" >> "$list"; shift 2
  done
  printf "file '%s/blank.png'\n" "$T" >> "$list"
  ffmpeg -y -loglevel error -f concat -safe 0 -i "$list" -vf "fps=15,format=yuvj420p" -c:v mjpeg -q:v 3 -f mjpeg "$OUT/$name.mjpeg"; rm "$list"; }
mkp pallets p-009 6 p-010 7 p-003 7 p-001 7 p-000 10
mkp stack p-006 30
mkp damaged p-000 60
rm -r "$T"
