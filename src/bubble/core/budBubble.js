import * as THREE from 'three'
import { applyGenomeLook } from './applyGenome.js'
import { createZoomMaterial } from './shader.js'

// A baby bubble stuck to the parent: a double bubble. Plateau's laws fix the
// shape: the three films meet at 120 degrees, the centres are
// d = sqrt(R^2 + r^2 - R r) apart, and the shared wall is a spherical cap of
// radius Rw = R r / (R - r), bulging into the larger bubble. Each outer film
// is hidden where it lies inside the other bubble (shader uCut).

export function budGeometry(R, r) {
  const distance = Math.sqrt(R * R + r * r - R * r)
  const contact = (R * R - r * r + distance * distance) / (2 * distance) // from the parent centre
  const ring = Math.sqrt(Math.max(0, R * R - contact * contact)) // contact circle radius
  const wallRadius = (R * r) / (R - r)
  const wallCentre = contact + Math.sqrt(Math.max(0, wallRadius * wallRadius - ring * ring))
  const capAngle = Math.asin(Math.min(1, ring / wallRadius))
  return { distance, contact, ring, wallRadius, wallCentre, capAngle }
}

const UP = new THREE.Vector3(0, 1, 0)

// parent: the bubble mesh (unit sphere in its own space). Returns null when
// the genome has no baby bubble.
export function createBud(parent, genome, sphereGeometry) {
  if (!genome.budRadius) return null
  const parentMaterial = parent.material
  const r = genome.budRadius
  const shape = budGeometry(1, r)
  const c = Math.cos(genome.budLatitude)
  const direction = new THREE.Vector3(c * Math.sin(genome.budLongitude), Math.sin(genome.budLatitude), c * Math.cos(genome.budLongitude))
  direction.normalize()

  function material() {
    const m = createZoomMaterial(parentMaterial.uniforms.uEnv.value, parentMaterial.uniforms.uFilmLut.value)
    applyGenomeLook(m.uniforms, { ...genome, patternSeed: (genome.patternSeed + 7919) >>> 0 })
    // Smaller bubbles drain faster: a thinner, livelier film.
    m.uniforms.uThicknessScale.value = 0.72
    return m
  }

  const bud = new THREE.Mesh(sphereGeometry, material())
  bud.position.copy(direction).multiplyScalar(shape.distance)
  bud.scale.setScalar(r)
  // The shared wall: a cap of the wall sphere around its pole, turned so the
  // pole points toward the parent's centre.
  const wall = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 12, 0, Math.PI * 2, 0, shape.capAngle), material())
  wall.position.copy(direction).multiplyScalar(shape.wallCentre)
  wall.scale.setScalar(shape.wallRadius)
  wall.quaternion.setFromUnitVectors(UP, direction.clone().negate())
  parent.add(bud, wall)

  const budWorld = new THREE.Vector3()
  const parentWorld = new THREE.Vector3()
  const parentScale = new THREE.Vector3()
  const shared = ['uTime', 'uCameraPos', 'uViewSize', 'uEnvRotation', 'uFlow', 'uEnv']

  return {
    sync() {
      parent.updateMatrixWorld()
      bud.getWorldPosition(budWorld)
      parent.getWorldPosition(parentWorld)
      parent.getWorldScale(parentScale)
      // Hide the parent's film inside the bud, and the bud's inside the parent.
      parentMaterial.uniforms.uCut.value.set(budWorld.x, budWorld.y, budWorld.z, r * parentScale.x)
      bud.material.uniforms.uCut.value.set(parentWorld.x, parentWorld.y, parentWorld.z, parentScale.x)
      for (const m of [bud.material, wall.material]) {
        for (const key of shared) {
          const from = parentMaterial.uniforms[key].value
          const to = m.uniforms[key]
          if (from && from.isVector3) to.value.copy(from)
          else if (from && from.isMatrix3) to.value.copy(from)
          else to.value = from
        }
      }
    },
    dispose() {
      parent.remove(bud, wall)
      bud.material.dispose()
      wall.material.dispose()
      wall.geometry.dispose()
      parentMaterial.uniforms.uCut.value.set(0, 0, 0, 0)
    },
  }
}
