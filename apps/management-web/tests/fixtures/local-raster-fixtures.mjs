import { writeArrayBuffer } from "geotiff";

// Original tiny rasters generated entirely in memory. No external dataset or file.
// Encode GeoKeys explicitly: the upstream beta writer omits some valid datum keys.
const ids = {
  GTModelTypeGeoKey: 1024, GTRasterTypeGeoKey: 1025,
  GeographicTypeGeoKey: 2048, GeogCitationGeoKey: 2049,
  GeogGeodeticDatumGeoKey: 2050, GeogAngularUnitsGeoKey: 2054,
  GeogEllipsoidGeoKey: 2056, GeogTOWGS84GeoKey: 2062,
  ProjectedCSTypeGeoKey: 3072, ProjCoordTransGeoKey: 3075,
  ProjLinearUnitsGeoKey: 3076, VerticalCSTypeGeoKey: 4096,
};
export async function rasterFixture(metadata = {}, values = new Float32Array([1, 2, 3, 4])) {
  const tags = {
    width: 2, height: 2,
    GeographicTypeGeoKey: 4326,
    GTRasterTypeGeoKey: 1,
    ModelPixelScale: [1, 1, 0],
    ModelTiepoint: [0, 0, 0, -10, 20, 0],
    ...metadata,
  };
  const directory = [1, 1, 0, 0], doubles = [];
  let ascii = "";
  for (const [name, id] of Object.entries(ids)) {
    const value = tags[name]; delete tags[name];
    if (value === undefined) continue;
    directory[3]++;
    if (typeof value === "string") { const text = value + "|"; directory.push(id, 34737, text.length, ascii.length); ascii += text; }
    else if (Array.isArray(value)) { directory.push(id, 34736, value.length, doubles.length); doubles.push(...value); }
    else directory.push(id, 0, 1, value);
  }
  // Prevent writer fallback from replacing the explicit tiepoint; the directory above is authoritative.
  tags.GeographicTypeGeoKey = 4326;
  tags.GeoKeyDirectory = directory;
  if (ascii) tags.GeoAsciiParams = ascii;
  if (doubles.length) tags.GeoDoubleParams = doubles;
  return new Blob([await writeArrayBuffer(values, tags)], { type: "image/tiff" });
}
