#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const SIZE = 128;
const SCALE = 4;
const WORK_SIZE = SIZE * SCALE;
const work = new PNG({ width: WORK_SIZE, height: WORK_SIZE });

function mix(from, to, amount) {
    return from.map((value, index) =>
        Math.round(value + ((to[index] - value) * amount)));
}

function blendPixel(pixelX, pixelY, color) {
    const index = ((pixelY * WORK_SIZE) + pixelX) * 4;
    const sourceAlpha = (color[3] ?? 255) / 255;
    const destinationAlpha = work.data[index + 3] / 255;
    const outputAlpha = sourceAlpha + (destinationAlpha * (1 - sourceAlpha));

    if (outputAlpha === 0) {
        return;
    }

    for (let channel = 0; channel < 3; channel += 1) {
        work.data[index + channel] = Math.round(
            ((color[channel] * sourceAlpha) +
                (work.data[index + channel] * destinationAlpha * (1 - sourceAlpha))) /
            outputAlpha,
        );
    }
    work.data[index + 3] = Math.round(outputAlpha * 255);
}

function paint(bounds, colorAt) {
    const left = Math.max(0, Math.floor(bounds[0] * SCALE));
    const top = Math.max(0, Math.floor(bounds[1] * SCALE));
    const right = Math.min(WORK_SIZE, Math.ceil(bounds[2] * SCALE));
    const bottom = Math.min(WORK_SIZE, Math.ceil(bounds[3] * SCALE));

    for (let pixelY = top; pixelY < bottom; pixelY += 1) {
        const y = (pixelY + 0.5) / SCALE;
        for (let pixelX = left; pixelX < right; pixelX += 1) {
            const x = (pixelX + 0.5) / SCALE;
            const color = colorAt(x, y);
            if (color) {
                blendPixel(pixelX, pixelY, color);
            }
        }
    }
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
    const right = left + width;
    const bottom = top + height;
    if (x < left || x > right || y < top || y > bottom) {
        return false;
    }
    const nearestX = Math.max(left + radius, Math.min(x, right - radius));
    const nearestY = Math.max(top + radius, Math.min(y, bottom - radius));
    return Math.hypot(x - nearestX, y - nearestY) <= radius;
}

function roundedRect(left, top, width, height, radius, color) {
    paint([left, top, left + width, top + height], (x, y) =>
        insideRoundedRect(x, y, left, top, width, height, radius)
            ? (typeof color === 'function' ? color(x, y) : color)
            : null);
}

function roundedRectStroke(left, top, width, height, radius, thickness, color) {
    paint([left, top, left + width, top + height], (x, y) => {
        const outer = insideRoundedRect(x, y, left, top, width, height, radius);
        const inner = insideRoundedRect(
            x,
            y,
            left + thickness,
            top + thickness,
            width - (2 * thickness),
            height - (2 * thickness),
            Math.max(0, radius - thickness),
        );
        return outer && !inner ? color : null;
    });
}

function polygon(points, color) {
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    paint([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], (x, y) => {
        let inside = false;
        for (let current = 0, previous = points.length - 1;
            current < points.length;
            previous = current, current += 1) {
            const [currentX, currentY] = points[current];
            const [previousX, previousY] = points[previous];
            if (((currentY > y) !== (previousY > y)) &&
                (x < (((previousX - currentX) * (y - currentY)) /
                    (previousY - currentY)) + currentX)) {
                inside = !inside;
            }
        }
        return inside ? (typeof color === 'function' ? color(x, y) : color) : null;
    });
}

function circle(centerX, centerY, radius, color) {
    paint(
        [centerX - radius, centerY - radius, centerX + radius, centerY + radius],
        (x, y) => Math.hypot(x - centerX, y - centerY) <= radius
            ? (typeof color === 'function' ? color(x, y) : color)
            : null,
    );
}

function circleStroke(centerX, centerY, radius, thickness, color) {
    paint(
        [
            centerX - radius - thickness,
            centerY - radius - thickness,
            centerX + radius + thickness,
            centerY + radius + thickness,
        ],
        (x, y) => {
            const distance = Math.hypot(x - centerX, y - centerY);
            return Math.abs(distance - radius) <= thickness / 2
                ? (typeof color === 'function' ? color(x, y) : color)
                : null;
        },
    );
}

function line(startX, startY, endX, endY, thickness, color) {
    const half = thickness / 2;
    paint(
        [
            Math.min(startX, endX) - half,
            Math.min(startY, endY) - half,
            Math.max(startX, endX) + half,
            Math.max(startY, endY) + half,
        ],
        (x, y) => {
            const deltaX = endX - startX;
            const deltaY = endY - startY;
            const lengthSquared = (deltaX * deltaX) + (deltaY * deltaY);
            const amount = Math.max(0, Math.min(
                1,
                (((x - startX) * deltaX) + ((y - startY) * deltaY)) /
                    lengthSquared,
            ));
            const nearestX = startX + (amount * deltaX);
            const nearestY = startY + (amount * deltaY);
            return Math.hypot(x - nearestX, y - nearestY) <= half ? color : null;
        },
    );
}

function ellipseStroke(centerX, centerY, radiusX, radiusY, thickness, color) {
    paint(
        [
            centerX - radiusX - thickness,
            centerY - radiusY - thickness,
            centerX + radiusX + thickness,
            centerY + radiusY + thickness,
        ],
        (x, y) => {
            const normalized = Math.hypot(
                (x - centerX) / radiusX,
                (y - centerY) / radiusY,
            );
            const normalizedThickness = thickness / Math.min(radiusX, radiusY);
            return Math.abs(normalized - 1) <= normalizedThickness / 2 ? color : null;
        },
    );
}

function ellipse(centerX, centerY, radiusX, radiusY, color) {
    paint(
        [
            centerX - radiusX,
            centerY - radiusY,
            centerX + radiusX,
            centerY + radiusY,
        ],
        (x, y) => {
            const normalized = Math.hypot(
                (x - centerX) / radiusX,
                (y - centerY) / radiusY,
            );
            return normalized <= 1
                ? (typeof color === 'function' ? color(x, y) : color)
                : null;
        },
    );
}

function ellipseFrontArc(centerX, centerY, radiusX, radiusY, thickness, color) {
    paint(
        [
            centerX - radiusX - thickness,
            centerY,
            centerX + radiusX + thickness,
            centerY + radiusY + thickness,
        ],
        (x, y) => {
            const normalized = Math.hypot(
                (x - centerX) / radiusX,
                (y - centerY) / radiusY,
            );
            const normalizedThickness = thickness / Math.min(radiusX, radiusY);
            return Math.abs(normalized - 1) <= normalizedThickness / 2 ? color : null;
        },
    );
}

function pixelText(text, left, top, pixelSize, color) {
    const glyphs = {
        S: ['111', '100', '111', '001', '111'],
        Q: ['111', '101', '101', '111', '001'],
        L: ['100', '100', '100', '100', '111'],
    };
    let cursor = left;
    for (const character of text) {
        const glyph = glyphs[character];
        for (let row = 0; row < glyph.length; row += 1) {
            for (let column = 0; column < glyph[row].length; column += 1) {
                if (glyph[row][column] === '1') {
                    roundedRect(
                        cursor + (column * pixelSize),
                        top + (row * pixelSize),
                        pixelSize,
                        pixelSize,
                        0,
                        color,
                    );
                }
            }
        }
        cursor += 4 * pixelSize;
    }
}

// A dark rounded tile remains legible in both light and dark Marketplace themes.
roundedRect(4, 4, 120, 120, 27, (x, y) => {
    const amount = Math.max(0, Math.min(1, ((x * 0.38) + (y * 0.62)) / 128));
    const base = mix([8, 20, 43], [8, 67, 88], amount);
    const glow = Math.max(0, 1 - (Math.hypot(x - 26, y - 17) / 95));
    return [
        base[0],
        Math.min(255, base[1] + Math.round(glow * 12)),
        Math.min(255, base[2] + Math.round(glow * 22)),
        255,
    ];
});
roundedRectStroke(4.75, 4.75, 118.5, 118.5, 26, 1.25, [66, 180, 207, 75]);

// Folded file with a subtle shadow.
polygon(
    [[31, 19], [69, 19], [88, 38], [88, 98], [81, 105], [30, 105], [23, 98], [23, 27]],
    [0, 5, 15, 80],
);
polygon(
    [[29, 16], [68, 16], [87, 35], [87, 96], [80, 103], [28, 103], [21, 96], [21, 24]],
    (x, y) => mix([249, 253, 255, 255], [215, 235, 245, 255], (y - 16) / 87),
);
polygon([[68, 16], [68, 35], [87, 35]], [170, 201, 218, 255]);
line(68.5, 16.5, 86.5, 34.5, 1.25, [255, 255, 255, 150]);

// Schema lines and data rows.
roundedRect(32, 45, 34, 2.5, 1.25, [48, 82, 105, 210]);
roundedRect(32, 54, 28, 2.5, 1.25, [48, 82, 105, 180]);
roundedRect(32, 63, 35, 2.5, 1.25, [48, 82, 105, 160]);
roundedRect(31, 75, 39, 24, 4, [174, 225, 237, 180]);
roundedRect(34, 78, 33, 4, 2, [42, 190, 211, 255]);
roundedRect(34, 85, 27, 4, 2, [17, 148, 183, 255]);
roundedRect(34, 92, 31, 4, 2, [11, 111, 153, 255]);

// Search lens: the database revealed inside connects file detection to SQL.
line(99, 94, 113, 108, 11, [0, 8, 18, 95]);
circle(83, 76, 26, [0, 8, 18, 75]);
line(98, 93, 113, 108, 8.5, [39, 197, 216, 255]);
circle(83, 76, 22, [8, 47, 66, 235]);
circleStroke(83, 76, 23, 6, (x, y) => {
    const amount = Math.max(0, Math.min(1, (x + y - 100) / 100));
    return mix([151, 244, 247, 255], [25, 181, 207, 255], amount);
});
circleStroke(83, 76, 19.75, 1, [218, 253, 255, 105]);

const databaseTop = [65, 169, 232, 255];
const databaseUpper = [48, 130, 209, 255];
const databaseMiddle = [27, 93, 178, 255];
const databaseBase = [13, 64, 128, 255];

// Build the reference-style cylinder back-to-front so each band's lower edge
// retains its curve while the outside reads as one continuous database.
ellipse(83, 85, 14, 4.5, databaseBase);
roundedRect(69, 64, 28, 21, 0, databaseBase);
roundedRect(69, 69.5, 28, 11.5, 0, databaseMiddle);
ellipse(83, 81, 14, 4.5, databaseMiddle);
roundedRect(69, 64, 28, 7, 0, databaseUpper);
ellipse(83, 71, 14, 4.5, databaseUpper);
ellipse(83, 64, 14, 4.5, databaseTop);
ellipseStroke(83, 64, 14, 4.5, 0.75, [106, 201, 246, 210]);
ellipseFrontArc(83, 85, 14, 4.5, 0.8, [5, 43, 94, 210]);
pixelText('SQL', 72, 73, 2, [255, 255, 255, 255]);

// Downsample with premultiplied alpha for smooth edges without dark halos.
const output = new PNG({ width: SIZE, height: SIZE });
for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
        let alphaTotal = 0;
        const premultiplied = [0, 0, 0];
        for (let sampleY = 0; sampleY < SCALE; sampleY += 1) {
            for (let sampleX = 0; sampleX < SCALE; sampleX += 1) {
                const sourceIndex =
                    ((((y * SCALE) + sampleY) * WORK_SIZE) +
                        ((x * SCALE) + sampleX)) * 4;
                const alpha = work.data[sourceIndex + 3] / 255;
                alphaTotal += alpha;
                for (let channel = 0; channel < 3; channel += 1) {
                    premultiplied[channel] += work.data[sourceIndex + channel] * alpha;
                }
            }
        }
        const outputIndex = ((y * SIZE) + x) * 4;
        const sampleCount = SCALE * SCALE;
        for (let channel = 0; channel < 3; channel += 1) {
            output.data[outputIndex + channel] = alphaTotal === 0
                ? 0
                : Math.round(premultiplied[channel] / alphaTotal);
        }
        output.data[outputIndex + 3] = Math.round((alphaTotal / sampleCount) * 255);
    }
}

const outputPath = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(outputPath, PNG.sync.write(output));
console.log(`Generated ${path.relative(process.cwd(), outputPath)} (${SIZE}x${SIZE})`);
