import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from layer_rig_psd.proof import compare, compose_package


class PixelProof(unittest.TestCase):
    def test_linear_legacy_and_srgb_pma(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            layers = []
            for id, color in [('back',(0,0,0,255)),('front',(255,0,0,128))]:
                Image.new('RGBA',(1,1),color).save(root/(id+'.png'))
                layers.append(dict(layerId=id,texture=id+'.png',visible=True,rect=[0,0,1,1],opacity=1))
            m = dict(format='koma-rig.slices.v2',canvas=dict(width=1,height=1),layers=layers)
            self.assertEqual(round(255*compose_package(root,m)[0,0,0]),128)
            m['format'] = 'koma-rig.slices.v1'
            self.assertEqual(round(255*compose_package(root,m)[0,0,0]),188)

    def test_knockout_coverage_hole_and_pixel_locations(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            Image.new('RGBA',(3,1),(20,40,60,255)).save(root/'back.png')
            top = Image.new('RGBA',(3,1))
            for i,a in enumerate([255,128,0]): top.putpixel((i,0),(20,40,60,a))
            top.save(root/'top.png')
            layers = [dict(layerId=id,texture=id+'.png',rect=[-1,0,3,1],visible=True,opacity=1) for id in ['back','top']]
            m = dict(format='koma-rig.slices.v2',canvas=dict(width=2,height=1),reference='ref.png',layers=layers,
                     gelGroups=[dict(opacity=.5,members=[dict(layerId=id,coverage=id+'.png') for id in ['back','top']])])
            actual = compose_package(root,m)
            np.testing.assert_allclose(actual[0,0],actual[0,1])
            self.assertEqual(actual[0,0,3],.5)
            reference=Image.new('RGBA',(2,1),(20,40,60,128))
            reference.putpixel((1,0),(20,40,60,0))
            reference.save(root/'ref.png')
            report=compare(root,m,actual,1,root/'heat.png')
            self.assertEqual((report['mismatches'],report['bounds'],report['maxError']),(1,[1,0,2,1],128))
            with Image.open(root/'heat.png') as heat: self.assertEqual(heat.getpixel((1,0)),(255,32,0,255))
