#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
MMD=diagrams/01-service-overview.mmd
SVG=diagrams/01-service-overview.svg

MMDC_ARGS=(-i "$MMD" -o "$SVG" -b white)
if [ -n "${PUPPETEER_CONFIG:-}" ]; then
  MMDC_ARGS=(-p "$PUPPETEER_CONFIG" "${MMDC_ARGS[@]}")
elif [ -x /usr/bin/chromium ]; then
  PPTR_TMP=$(mktemp)
  printf '{"executablePath": "/usr/bin/chromium", "args": ["--no-sandbox", "--disable-gpu"]}\n' > "$PPTR_TMP"
  MMDC_ARGS=(-p "$PPTR_TMP" "${MMDC_ARGS[@]}")
fi
mmdc "${MMDC_ARGS[@]}"

python3 - "$SVG" <<'EOF'
import re
import sys
import xml.etree.ElementTree as ET

svg_path = sys.argv[1]
svg = open(svg_path).read()

LEFT_COLUMN = ("Browser", "ExtMCP", "JWTC", "Agent")
CORNER_RADIUS = 7.0710678118655


def node_geometry(name):
    match = re.search(
        rf'<g[^>]*id="my-svg-flowchart-{name}-\d+"[^>]*transform="translate\(([\d.]+),\s*([\d.]+)\)"[^>]*>.*?'
        r'<rect[^>]*x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"',
        svg,
        re.S,
    )
    if not match:
        sys.exit(f"render-diagram: node {name} not found; the geometry pass no longer applies")
    cx, cy, rx, ry, w, h = map(float, match.groups())
    return {"cx": cx, "cy": cy, "left": cx + rx, "right": cx + rx + w, "top": cy + ry, "bottom": cy + ry + h}


def straighten_frontend_lane():
    global svg
    fe = node_geometry("FE")
    edge = re.search(r'(<path d=")([^"]+)("[^>]*id="my-svg-L_FE_DISC_0")', svg)
    if not edge:
        sys.exit("render-diagram: L_FE_DISC_0 edge not found; the straight-lane patch no longer applies")

    tip_x, tip_y = map(float, re.findall(r'L\s*([\d.]+)[, ]([\d.]+)', edge.group(2))[-1])
    if tip_y <= fe["bottom"]:
        sys.exit("render-diagram: Discovery entry no longer sits below the frontend; the straight-lane patch no longer applies")

    new_d = (
        f'M{fe["cx"]},{fe["bottom"]}'
        f'L{fe["cx"]},{tip_y - CORNER_RADIUS}'
        f'Q{fe["cx"]},{tip_y} {fe["cx"] + CORNER_RADIUS},{tip_y}'
        f"L{tip_x},{tip_y}"
    )
    svg = svg.replace(edge.group(0), f"{edge.group(1)}{new_d}{edge.group(3)}")

    label_text_at = svg.find("1 region")
    if label_text_at == -1:
        sys.exit("render-diagram: flow label not found")
    label_at = svg.rfind('class="edgeLabel" transform="translate(', 0, label_text_at)
    label = re.match(r'class="edgeLabel" transform="translate\(([\d.]+),\s*([\d.]+)\)"', svg[label_at:])
    if not label:
        sys.exit("render-diagram: flow label transform not found")
    svg = svg.replace(
        svg[label_at:label_at + label.end()],
        f'class="edgeLabel" transform="translate({label.group(1)}, {tip_y - 0.5})"',
        1,
    )
    print(f'render-diagram: rerouted FE->DISC from ({fe["cx"]},{fe["bottom"]}) along y={tip_y}')


def normalise_column(names, bounds=None):
    global svg
    geometry = {name: node_geometry(name) for name in names}
    left = bounds[0] if bounds else min(g["left"] for g in geometry.values())
    right = bounds[1] if bounds else max(g["right"] for g in geometry.values())
    width = right - left
    center_x = (left + right) / 2

    for name, node in geometry.items():
        tag = re.search(rf'<g[^>]*id="my-svg-flowchart-{name}-\d+"[^>]*>', svg)
        retagged = re.sub(r'translate\([\d.]+,', f"translate({center_x},", tag.group(0))
        svg = svg.replace(tag.group(0), retagged)

        rect_at = svg.find("<rect", svg.find(retagged))
        rect = re.match(r'<rect[^>]*>', svg[rect_at:]).group(0)
        resized = re.sub(r'x="-?[\d.]+"', f'x="{-width / 2}"', rect, count=1)
        resized = re.sub(r'width="[\d.]+"', f'width="{width}"', resized, count=1)
        svg = svg.replace(rect, resized, 1)

        for edge in re.finditer(rf'(<path d=")([^"]+)("[^>]*id="my-svg-L_{name}_\w+?_\d+")', svg):
            moved = re.sub(r'^M[\d.]+,', f"M{right},", edge.group(2), count=1)
            svg = svg.replace(edge.group(0), f"{edge.group(1)}{moved}{edge.group(3)}")
        for edge in re.finditer(rf'(<path d=")([^"]+)("[^>]*id="my-svg-L_\w+?_{name}_\d+")', svg):
            old_tip_x = float(re.findall(r'L\s*([\d.]+)[, ][\d.]+$', edge.group(2))[0])
            arrow_gap = node["left"] - old_tip_x
            moved = re.sub(r'L[\d.]+,([\d.]+)$', f"L{left - arrow_gap},\\1", edge.group(2), count=1)
            svg = svg.replace(edge.group(0), f"{edge.group(1)}{moved}{edge.group(3)}")

    print(f"render-diagram: column {'/'.join(names)} normalised to width={width:.1f} centred at x={center_x:.1f}")


def normalise_left_column():
    anchor = node_geometry("Browser")
    width = max(node_geometry(name)["right"] - node_geometry(name)["left"] for name in LEFT_COLUMN)
    normalise_column(LEFT_COLUMN, bounds=(anchor["left"], anchor["left"] + width))


def normalise_right_column():
    global svg
    clusters = list(re.finditer(r'(<g[^>]*class="cluster"[^>]*>\s*<rect[^>]*x=")([\d.]+)(" y="[\d.]+" width=")([\d.]+)(")', svg))
    if len(clusters) != 2:
        sys.exit("render-diagram: expected the two right-column frames; the geometry pass no longer applies")

    frame_x_values = {float(cluster.group(2)) for cluster in clusters}
    if len(frame_x_values) != 1:
        sys.exit("render-diagram: right-column frames are no longer left-aligned; the geometry pass no longer applies")
    frame_x = frame_x_values.pop()
    frame_width = max(float(cluster.group(4)) for cluster in clusters)

    labels = list(re.finditer(r'(class="cluster-label"[^>]*transform="translate\()([\d.]+)(,\s*[\d.]+\)")', svg))
    for cluster, label in zip(clusters, labels):
        delta = (frame_width - float(cluster.group(4))) / 2
        svg = svg.replace(cluster.group(0), f"{cluster.group(1)}{cluster.group(2)}{cluster.group(3)}{frame_width}{cluster.group(5)}", 1)
        svg = svg.replace(label.group(0), f"{label.group(1)}{float(label.group(2)) + delta}{label.group(3)}", 1)

    pad = node_geometry("IDP")["left"] - frame_x
    normalise_column(("ACME", "MOCK", "IDP", "DISC", "ACC"), bounds=(frame_x + pad, frame_x + frame_width - pad))
    normalise_column(("OLL", "RD", "PG"), bounds=(frame_x, frame_x + frame_width))


# A two-bend elbow connector, as ELK emits it: leave the source at (sx,sy), run
# horizontal to a rounded turn onto the shared trunk x, run vertical, rounded turn
# back onto the target y, run horizontal into the target. `t` (the trunk) and each
# bend's radius offset are matched by backreference, not by value, so reconstruction
# never depends on two different numbers coincidentally matching.
_ELBOW_IN = re.compile(
    r'^M(?P<sx>[\d.]+),(?P<sy>[\d.]+)'
    r'L(?P<cr1>[\d.]+),(?P=sy)'
    r'Q(?P<t>[\d.]+),(?P=sy) (?P=t),(?P<my>[\d.]+)'
    r'L(?P=t),(?P<by>[\d.]+)'
    r'Q(?P=t),(?P<gy>[\d.]+) (?P<cr2>[\d.]+),(?P=gy)'
    r'L(?P<tip>[\d.]+),(?P=gy)$'
)
_STRAIGHT_IN = re.compile(r'^M(?P<sx>[\d.]+),(?P<sy>[\d.]+)L(?P<tip>[\d.]+),(?P=sy)$')
_ELBOW_OUT = re.compile(
    r'^M(?P<sx>[\d.]+),(?P<sy>[\d.]+)'
    r'L(?P<cr1>[\d.]+),(?P=sy)'
    r'Q(?P<t>[\d.]+),(?P=sy) (?P=t),(?P<my>[\d.]+)'
    r'L(?P=t),(?P<by>[\d.]+)'
    r'Q(?P=t),(?P<ty>[\d.]+) (?P<cr2>[\d.]+),(?P=ty)'
    r'(?P<rest>L.*)$'
)
_NEAR_BOX = 30


def _reroute_incoming(d, box_left_old, box_left_new, runway):
    bend = _ELBOW_IN.match(d)
    if bend:
        g = bend.groupdict()
        tip_old, t_old = float(g["tip"]), float(g["t"])
        tip_new = box_left_new - (box_left_old - tip_old)
        t_new = box_left_new - runway if abs(t_old - box_left_old) <= _NEAR_BOX else t_old
        return (
            f'M{g["sx"]},{g["sy"]}'
            f'L{t_new - CORNER_RADIUS},{g["sy"]}'
            f'Q{t_new},{g["sy"]} {t_new},{g["my"]}'
            f'L{t_new},{g["by"]}'
            f'Q{t_new},{g["gy"]} {t_new + CORNER_RADIUS},{g["gy"]}'
            f'L{tip_new},{g["gy"]}'
        )

    straight = _STRAIGHT_IN.match(d)
    if not straight:
        sys.exit(f"render-diagram: incoming gateway edge has an unrecognised shape; the emphasis pass no longer applies:\n{d}")
    g = straight.groupdict()
    tip_new = box_left_new - (box_left_old - float(g["tip"]))
    return f'M{g["sx"]},{g["sy"]}L{tip_new},{g["sy"]}'


def _reroute_outgoing(d, box_right_old, box_right_new, runway):
    bend = _ELBOW_OUT.match(d)
    if not bend:
        sys.exit(f"render-diagram: outgoing gateway edge has an unrecognised shape; the emphasis pass no longer applies:\n{d}")
    g = bend.groupdict()
    t_old = float(g["t"])
    near_box = abs(t_old - box_right_old) <= _NEAR_BOX
    t_new = box_right_new + runway if near_box else t_old
    cr1_new = t_new - CORNER_RADIUS if near_box else g["cr1"]
    cr2_new = t_new + CORNER_RADIUS if near_box else g["cr2"]
    return (
        f'M{box_right_new},{g["sy"]}'
        f'L{cr1_new},{g["sy"]}'
        f'Q{t_new},{g["sy"]} {t_new},{g["my"]}'
        f'L{t_new},{g["by"]}'
        f'Q{t_new},{g["ty"]} {cr2_new},{g["ty"]}'
        f'{g["rest"]}'
    )


def emphasise_gateway(grow=20, runway_in=60, runway_out=60):
    global svg
    gw = node_geometry("GW")
    old_left, old_right = gw["left"], gw["right"]
    new_left, new_right = gw["left"] - grow, gw["right"] + grow

    tag = re.search(r'<g[^>]*id="my-svg-flowchart-GW-\d+"[^>]*>', svg)
    rect_at = svg.find("<rect", svg.find(tag.group(0)))
    rect = re.match(r'<rect[^>]*>', svg[rect_at:]).group(0)
    width = gw["right"] - gw["left"] + 2 * grow
    height = gw["bottom"] - gw["top"] + 2 * grow
    resized = re.sub(r'x="-?[\d.]+"', f'x="{-width / 2}"', rect, count=1)
    resized = re.sub(r'y="-?[\d.]+"', f'y="{-height / 2}"', resized, count=1)
    resized = re.sub(r'width="[\d.]+"', f'width="{width}"', resized, count=1)
    resized = re.sub(r'height="[\d.]+"', f'height="{height}"', resized, count=1)
    svg = svg.replace(rect, resized, 1)

    incoming = list(re.finditer(r'<path d="([^"]+)"[^>]*id="my-svg-(L_\w+?_GW_\d+)"', svg))
    outgoing = list(re.finditer(r'<path d="([^"]+)"[^>]*id="my-svg-(L_GW_\w+?_\d+)"', svg))
    if not incoming or not outgoing:
        sys.exit("render-diagram: gateway edges not found; the emphasis pass no longer applies")

    def shift_label(edge_id, delta):
        label = re.search(
            rf'(<g class="edgeLabel" transform="translate\()([\d.]+)(,\s*[\d.]+\)">'
            rf'<g class="label" data-id="{edge_id}")',
            svg,
        )
        if not label:
            sys.exit(f"render-diagram: edge label for {edge_id} not found; the emphasis pass no longer applies")
        svg_local = svg.replace(label.group(0), f"{label.group(1)}{float(label.group(2)) + delta}{label.group(3)}", 1)
        return svg_local

    for old_d, edge_id in [(m.group(1), m.group(2)) for m in incoming]:
        new_d = _reroute_incoming(old_d, old_left, new_left, runway_in)
        svg = svg.replace(f'<path d="{old_d}"', f'<path d="{new_d}"', 1)
        svg = shift_label(edge_id, -(runway_in - 20))

    for old_d, edge_id in [(m.group(1), m.group(2)) for m in outgoing]:
        new_d = _reroute_outgoing(old_d, old_right, new_right, runway_out)
        svg = svg.replace(f'<path d="{old_d}"', f'<path d="{new_d}"', 1)
        svg = shift_label(edge_id, runway_out - 20)

    print(f"render-diagram: gateway emphasised (box +{2 * grow}px, incoming runway={runway_in}, outgoing runway={runway_out})")


def extend_canvas_if_clipped(margin=20):
    global svg
    xs, ys = [], []
    for match in re.finditer(r'<rect[^>]*x="(-?[\d.]+)"[^>]*y="(-?[\d.]+)"[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"', svg):
        x, y, w, h = map(float, match.groups())
        if -50 < x < 3000:
            xs += [x, x + w]
            ys += [y, y + h]

    view = re.search(r'viewBox="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"', svg)
    vx, vy, vw, vh = map(float, view.groups())
    max_x, max_y = max(xs), max(ys)
    needed_w, needed_h = max_x - vx + margin, max_y - vy + margin
    if needed_w <= vw and needed_h <= vh:
        print("render-diagram: canvas already fits the diagram, no extension needed")
        return

    new_w, new_h = max(vw, needed_w), max(vh, needed_h)
    svg = svg.replace(view.group(0), f'viewBox="{vx} {vy} {new_w} {new_h}"', 1)
    svg = re.sub(r'(style="[^"]*max-width:\s*)[\d.]+(px[^"]*")', rf'\g<1>{new_w}\g<2>', svg, count=1)
    print(f"render-diagram: extended canvas to {new_w:.0f}x{new_h:.0f} (was {vw:.0f}x{vh:.0f})")


normalise_left_column()
normalise_right_column()
emphasise_gateway()
straighten_frontend_lane()
extend_canvas_if_clipped()

ET.fromstring(svg)
open(svg_path, "w").write(svg)
if open(svg_path).read() != svg:
    sys.exit("render-diagram: written SVG does not match the patched content; re-run (bind-mount write flake)")
EOF
