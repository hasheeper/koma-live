import unittest
import numpy as np
from warp import (
    couple_hair_parallax,
    dampen_eye_roll_on_pitch,
    forward,
    fit_field,
    horizontal_curvature,
    jacobians,
    lattice_points,
    pin_lattice,
    register_features,
    symmetrize_pitch_field,
    symmetrize_yaw_pair,
)


class WarpTests(unittest.TestCase):
    def test_pitch_symmetry_and_roll_removal(self):
        points = lattice_points([50, 30, 80, 40], [6, 4]).reshape(-1, 2)
        weights = np.ones(len(points))
        # Pure pitch with accidental roll (+0.15 * x) and vertical gradient (-0.08 * y)
        dy = 4.0 + 0.15 * (points[:, 0] - 90.0) - 0.08 * (points[:, 1] - 50.0)
        cleaned = dampen_eye_roll_on_pitch(points, dy, weights)
        expected = 4.0 - 0.08 * (points[:, 1] - 50.0)
        np.testing.assert_allclose(cleaned, expected, atol=1e-12)

        skewed = lambda q: np.column_stack((np.full(len(q), 3.0) + 0.05 * (q[:, 0] - 100.0), 5.0 + 0.1 * (q[:, 0] - 100.0)))
        sym = symmetrize_pitch_field(skewed, 100.0)
        probe = np.array([[80.0, 50.0], [100.0, 50.0], [120.0, 50.0]])
        out = sym(probe)
        self.assertAlmostEqual(out[1, 0], 0.0, places=12)
        self.assertAlmostEqual(out[0, 1], out[2, 1], places=12)
        self.assertAlmostEqual(out[0, 0], -out[2, 0], places=12)

        f_neg = lambda q: np.column_stack((np.full(len(q), -6.0), np.full(len(q), 1.0)))
        f_pos = lambda q: np.column_stack((np.full(len(q), 10.0), np.full(len(q), -3.0)))
        s_neg, s_pos = symmetrize_yaw_pair(f_neg, f_pos, 100.0)
        np.testing.assert_allclose(s_neg(probe)[:, 0], -s_pos(probe[::-1])[:, 0], atol=1e-12)
        np.testing.assert_allclose(s_neg(probe)[:, 1], s_pos(probe[::-1])[:, 1], atol=1e-12)

        coupled = couple_hair_parallax(f_neg, f_pos, lambda q: f_pos(q) + [4.0, 2.0], 0.25)
        np.testing.assert_allclose(coupled(probe), f_neg(probe) + [1.0, 0.5], atol=1e-12)

    def test_yaw_curvature_preserves_weighted_affine_motion(self):
        points = lattice_points([50,30,80,40], [6,4]).reshape(-1,2)
        weights = np.linspace(.4, 1, len(points))
        basis = np.column_stack((points, np.ones(len(points))))
        affine = basis @ [.17, -.2, 4.]
        np.testing.assert_allclose(horizontal_curvature(points, affine, weights), 0, atol=1e-12)
        curved = affine + .003*(points[:,0]-90)**2
        extra = horizontal_curvature(points, curved, weights)
        self.assertGreater(np.max(np.abs(extra)), 1)
        np.testing.assert_allclose(basis.T @ (weights*extra), 0, atol=1e-9)

    def test_known_affine_and_nonidentity_neutral(self):
        crop = (23, -18, 2064)
        for width in (256,512):
            uv = (np.arange(width)+.5) / width * 2-1
            grid = np.stack(np.meshgrid(uv,uv),axis=-1)
            matrix = np.array([[-.08,.025],[-.01,.06]])
            target = grid @ matrix.T + [.030,-.012]
            neutral = np.zeros_like(target) + [.017,.008]
            p = np.stack(np.meshgrid(np.linspace(-.65,.65,23),np.linspace(-.65,.65,23)),axis=-1)
            world = (p+1)*crop[2]/2 + crop[:2]
            delta, err = forward(world,neutral,target,crop)
            exact = ((p+[.017,.008]-[.030,-.012]) @ np.linalg.inv(np.eye(2)+matrix).T-p)*crop[2]/2
            self.assertLess(np.linalg.norm(delta-exact,axis=-1).max(),.05)
            self.assertLess(err.max(),.01)
            self.assertTrue((forward(world,neutral,neutral,crop)[0] == 0).all())

    def test_tps_and_bilinear_jacobian(self):
        points = lattice_points([35,46,27,19],[4,6])
        pts = points.reshape(-1,2)
        field = fit_field(pts,.1*pts,np.ones(len(pts)),27,.02)
        np.testing.assert_allclose(field(pts),.1*pts,atol=1e-9)
        np.testing.assert_allclose(jacobians(points,.1*points),1.21)
        self.assertLess(jacobians(points,points*[-1.2,0]).min(),0)

    def test_feature_interpolates_identically_on_different_slice_triangles(self):
        field = lambda p: p**2 / 250
        locked = register_features(field, [{"fitRect":[10,10,40,20], "rect":[5,5,60,45], "featherPx":5}])
        triangle = np.array([[6,8],[62,13],[14,41]])
        weights = np.array([.1,.3,.6])
        np.testing.assert_allclose(weights @ locked(triangle), locked((weights @ triangle)[None])[0])
        outside = np.array([[2,62],[80,20]])
        np.testing.assert_allclose(locked(outside), field(outside))

    def test_neck_is_fixed_for_either_triangle_diagonal(self):
        rest = lattice_points([20,10,80,50], [1,1])
        off = np.array([[[.2,2.],[1.,3.]],[[3.,1.],[7.,9.]]])
        correction = pin_lattice(rest, off, np.array([44.,20.]))
        off -= correction
        np.testing.assert_allclose(.5*off[0,0]+.3*off[0,1]+.2*off[1,0],0,atol=1e-12)
        np.testing.assert_allclose(.7*off[0,0]+.1*off[0,1]+.2*off[1,1],0,atol=1e-12)
