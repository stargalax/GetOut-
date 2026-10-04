const r = (n) => Math.round(n * 10000) / 10000;
const close = (pts) => [...pts, [...pts[0]]];

function regularPolygon(n, startDeg = 90) {
    const pts = Array.from({ length: n }, (_, i) => {
        const a = ((startDeg + (360 * i) / n) * Math.PI) / 180;
        return [r(Math.cos(a)), r(Math.sin(a))];
    });
    return close(pts);
}

function star() {
    const pts = [];
    for (let i = 0; i < 10; i++) {
        const rad = i % 2 === 0 ? 1 : 0.4;
        const a = ((90 + 36 * i) * Math.PI) / 180;
        pts.push([r(rad * Math.cos(a)), r(rad * Math.sin(a))]);
    }
    return close(pts);
}

// Starts at the bottom tip of the heart
function heart(n = 24) {
    const pts = [];
    for (let i = 0; i < n; i++) {
        const t = Math.PI + (2 * Math.PI * i) / n;
        const x = 16 * Math.sin(t) ** 3;
        const y =
            13 * Math.cos(t) - 5 * Math.cos(2 * t) -
            2 * Math.cos(3 * t) - Math.cos(4 * t);
        pts.push([r(x / 17), r(y / 17)]);
    }
    return close(pts);
}

function house() {
    return close([
        [-0.8, -0.8], [0.8, -0.8], [0.8, 0.2], [0, 0.9], [-0.8, 0.2],
    ]);
}

export const SHAPES = {
    triangle: () => regularPolygon(3),
    square: () => regularPolygon(4, 45),
    diamond: () => regularPolygon(4, 90),
    pentagon: () => regularPolygon(5),
    hexagon: () => regularPolygon(6),
    octagon: () => regularPolygon(8),
    circle: () => regularPolygon(16),
    star,
    heart,
    house,
    rectangle: () => close([[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]]),
};

const KEYWORDS = [
    ["triangle", /triang/i],
    ["square", /square|box/i],
    ["rectangle", /rectang/i],
    ["diamond", /diamond|rhomb/i],
    ["pentagon", /pentagon/i],
    ["hexagon", /hexagon/i],
    ["octagon", /octagon/i],
    ["star", /star|pointy/i],
    ["heart", /heart|love/i],
    ["house", /house|home/i],
    ["circle", /circle|round|loop|oval/i],
];

export function matchShapeByKeyword(prompt) {
    return KEYWORDS.find(([, re]) => re.test(prompt))?.[0] ?? null;
}