"""All public points and offsets use the original artwork's pixel units."""
import numpy as np
from scipy.interpolate import RBFInterpolator
from scipy.ndimage import map_coordinates
from scipy.spatial import cKDTree


def sample_grid(grid, points, crop):
    left, top, side = crop
    h, w = grid.shape[:2]
    uv = (points - [left, top]) / side
    coords = [uv[..., 1] * h - .5, uv[..., 0] * w - .5]
    return np.stack([map_coordinates(grid[..., k], coords, order=1, mode="nearest")
                     for k in range(2)], axis=-1) * (side / 2)


def forward(points, neutral, target, crop, tolerance=.01, iterations=60):
    """Follow the same material point through both backwards sampling maps."""
    points = np.asarray(points, dtype=float)
    source = points + sample_grid(neutral, points, crop)
    q = points.copy()
    for _ in range(iterations):
        residual = source - q - sample_grid(target, q, crop)
        error = np.linalg.norm(residual, axis=-1)
        if error.max() <= tolerance:
            break
        q += .75 * residual
    error = np.linalg.norm(source - q - sample_grid(target, q, crop), axis=-1)
    return q - points, error


def controls(layer, alpha, limit=400):
    """One high-coverage control near the centre of each occupied spatial bin."""
    x, y, w, h = layer["rect"]
    py, px = np.nonzero(alpha > 153)
    if len(px) < 3:
        raise ValueError(f"{layer['layerId']} has fewer than three opaque controls")
    cell = max(1., np.sqrt(w * h / limit))
    bx, by = (px / cell).astype(int), (py / cell).astype(int)
    bins = by * (int(w / cell) + 1) + bx
    dist = (px / cell - bx - .5) ** 2 + (py / cell - by - .5) ** 2
    order = np.lexsort((dist, bins))
    keep = order[np.r_[True, np.diff(bins[order]) != 0]]
    return np.column_stack((x + px[keep] + .5, y + py[keep] + .5)), alpha[py[keep], px[keep]] / 255.


def fit_field(points, offsets, weights, scale, smoothing):
    origin = points.mean(axis=0)
    normalized = (points - origin) / scale
    tps = RBFInterpolator(normalized, offsets, smoothing=smoothing / weights,
                          kernel="thin_plate_spline")
    tree = cKDTree(points)

    def field(query):
        # Sample near the mask boundary for far transparent corners of a trimmed strand.
        # This bounds extrapolation without flattening the displacement inside its silhouette.
        distance, idx = tree.query(query)
        anchor = points[idx]
        limited = anchor + (query - anchor) * np.minimum(1., scale * .18 / np.maximum(distance, 1e-9))[:, None]
        return tps((limited - origin) / scale)
    return field


def lattice_points(rect, grid):
    x, y, w, h = rect
    cols, rows = grid
    xx, yy = np.meshgrid(np.linspace(x, x + w, cols + 1), np.linspace(y, y + h, rows + 1))
    return np.stack((xx, yy), axis=-1)


def horizontal_curvature(points, dx, weights):
    """Remove the best-fitting affine motion, leaving the non-affine bending component."""
    basis = points - np.average(points, axis=0, weights=weights)
    centered_dx = dx - np.average(dx, weights=weights)
    w = np.sqrt(weights)
    slope = np.linalg.lstsq(basis * w[:, None], centered_dx * w, rcond=None)[0]
    return centered_dx - basis @ slope


def symmetrize_pitch_field(field, center_x):
    """Mirror-symmetrize a pure-pitch field across center_x so eyes stay level and drift-free."""
    def symmetric(query):
        q = np.asarray(query, dtype=float)
        mirrored = q.copy()
        mirrored[:, 0] = 2.0 * center_x - mirrored[:, 0]
        a = field(q)
        b = field(mirrored)
        return np.column_stack(((a[:, 0] - b[:, 0]) * 0.5, (a[:, 1] + b[:, 1]) * 0.5))
    return symmetric


def symmetrize_yaw_pair(field_neg, field_pos, center_x):
    """Mirror-symmetrize opposite-yaw fields (-1, y) and (+1, y) across center_x."""
    def sym_neg(query):
        q = np.asarray(query, dtype=float)
        m = q.copy()
        m[:, 0] = 2.0 * center_x - m[:, 0]
        a = field_neg(q)
        b = field_pos(m)
        return np.column_stack(((a[:, 0] - b[:, 0]) * 0.5, (a[:, 1] + b[:, 1]) * 0.5))

    def sym_pos(query):
        q = np.asarray(query, dtype=float)
        m = q.copy()
        m[:, 0] = 2.0 * center_x - m[:, 0]
        a = field_pos(q)
        b = field_neg(m)
        return np.column_stack(((a[:, 0] - b[:, 0]) * 0.5, (a[:, 1] + b[:, 1]) * 0.5))

    return sym_neg, sym_pos


def couple_hair_parallax(face_clean, face_raw, hair_raw, parallax_scale):
    """Anchor an independent hair/ear layer onto the cleaned face motion plus scaled relative parallax."""
    s = float(parallax_scale)
    def coupled(query):
        q = np.asarray(query, dtype=float)
        return face_clean(q) + s * (hair_raw(q) - face_raw(q))
    return coupled


def dampen_eye_roll_on_pitch(points, dy, weights):
    """Remove accidental left-right roll slope (∂dy/∂x) from a pure-pitch vertical displacement."""
    cx = np.average(points[:, 0], weights=weights)
    cy = np.average(points[:, 1], weights=weights)
    dx_c = points[:, 0] - cx
    dy_c = points[:, 1] - cy
    centered = dy - np.average(dy, weights=weights)
    basis = np.column_stack((dx_c, dy_c))
    w = np.sqrt(weights)
    slope = np.linalg.lstsq(basis * w[:, None], centered * w, rcond=None)[0]
    return centered - dx_c * slope[0] - (centered - dy)


def register_features(field, regions):
    """Fit a common affine map inside each feature so different meshes interpolate identically."""
    patches = []
    for region in regions:
        sample = lattice_points(region["fitRect"], (5, 5)).reshape(-1, 2)
        center = sample.mean(axis=0)
        basis = np.column_stack((sample - center, np.ones(len(sample))))
        coefficients = np.linalg.lstsq(basis, field(sample), rcond=None)[0]
        x, y, w, h = region["rect"]
        feather = region["featherPx"]
        if min(w, h, feather, *region["fitRect"][2:]) <= 0:
            raise ValueError("Feature registration needs positive rectangles and featherPx")
        patches.append((np.array([x,y]), np.array([x+w,y+h]), feather, center, coefficients))

    def registered(query):
        offsets = field(query)
        for lo, hi, feather, center, coefficients in patches:
            outside = np.maximum(lo-query, query-hi).max(axis=1)
            t = np.clip(1 - outside/feather, 0, 1)
            weight = (t*t*(3-2*t))[:,None]
            affine = (query-center) @ coefficients[:2] + coefficients[2]
            offsets += weight * (affine - offsets)
        return offsets
    return registered


def pin_lattice(rest, offsets, anchor):
    """Make the anchor cell affine so every triangle split agrees at the neck."""
    last = np.array([rest.shape[1]-1, rest.shape[0]-1])
    uv = (anchor - rest[0,0]) / (rest[-1,-1] - rest[0,0])
    if (uv < 0).any() or (uv > 1).any():
        return None
    cell = np.minimum(np.floor(uv * last).astype(int), last-1)
    i, j = cell
    u, v = uv * last - cell
    patch = offsets[j:j+2, i:i+2]
    twist = (patch[0,0] - patch[0,1] - patch[1,0] + patch[1,1]) / 4
    patch[0,0] -= twist
    patch[1,1] -= twist
    patch[0,1] += twist
    patch[1,0] += twist
    return patch[0,0] + u*(patch[0,1]-patch[0,0]) + v*(patch[1,0]-patch[0,0])


def jacobians(rest, offsets):
    """Extrema of a bilinear cell's determinant occur at its four corners."""
    p = rest + offsets
    top = p[:-1, 1:] - p[:-1, :-1]
    bot = p[1:, 1:] - p[1:, :-1]
    left = p[1:, :-1] - p[:-1, :-1]
    right = p[1:, 1:] - p[:-1, 1:]
    area = (rest[0, 1, 0] - rest[0, 0, 0]) * (rest[1, 0, 1] - rest[0, 0, 1])
    return np.stack([(a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]) / area
                     for a in (top, bot) for b in (left, right)])
