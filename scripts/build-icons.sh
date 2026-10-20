#!/bin/sh
# Renders the toolbar icons (Lucide paths in icons-src/) to the PNG sizes ONLYOFFICE asks for.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/plugin/resources/icons"
for theme in light dark; do
	if [ "$theme" = light ]; then color='#444444'; else color='#e8e8e8'; fi
	mkdir -p "$out/$theme"
	for src in "$here"/icons-src/*.svg; do
		name=$(basename "$src" .svg)
		svg=$(mktemp)
		{
			printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 28 28" fill="none" stroke="%s" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' "$color"
			cat "$src"
			printf '</svg>'
		} > "$svg"
		for scale in 1 1.25 1.5 1.75 2; do
			size=$(awk "BEGIN{print int(28*$scale+0.5)}")
			if [ "$scale" = 1 ]; then suffix=''; else suffix="@${scale}x"; fi
			rsvg-convert -w "$size" -h "$size" "$svg" -o "$out/$theme/$name$suffix.png"
		done
		rm "$svg"
	done
done
