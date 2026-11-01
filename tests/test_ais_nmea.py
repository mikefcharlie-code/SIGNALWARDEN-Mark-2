"""AIVDM decoder tests with recorded/hand-made fixture sentences (no network).

Fixtures were cross-checked against the independent pyais 3.3.1 decoder when
written; pyais is not a dependency of this repository.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "management-api"))
import ais_nmea  # noqa: E402

# Published example sentence (pyais/gpsd documentation): type 1, MMSI 366053209.
PUBLISHED_T1 = "!AIVDM,1,1,,B,15M67FC000G?ufbE`FepT@3n00Sa,0*5C"
T1 = "!AIVDO,1,1,,A,13o08I0P1sPHG=HRSV77DmjwP000,0*03"
T3_MOORED = "!AIVDO,1,1,,A,13m:lHUP000i<AHRAog>4?v1P000,0*35"
T5 = ["!AIVDO,2,1,0,A,53o08I02HUWtiQU`000pu8@T>1@E=@0000000016<PD5:000000QDQiCP000,0*4E",
      "!AIVDO,2,2,0,A,00000000000,2*26"]
T18 = "!BSVDO,1,1,,A,B3n30V00@060QH8`QE0p@d000000,0*30"
T24A = "!AIVDO,1,1,,A,H3n30V1<D6098DE`D00000000000,0*3F"
T24B = "!AIVDO,1,1,,A,H3n30V4U0000000<1ijkl0000000,0*0C"


def tagged(sentence: str, epoch: int) -> str:
    tag = f"s:2573555,c:{epoch}"
    return f"\\{tag}*{ais_nmea.nmea_checksum(tag)}\\{sentence}"


class DecoderTests(unittest.TestCase):
    def setUp(self):
        self.asm = ais_nmea.AivdmAssembler()

    def test_published_type1(self):
        u = self.asm.feed(PUBLISHED_T1)
        self.assertEqual((u.msg_type, u.mmsi, u.nav_status), (1, 366053209, 3))
        self.assertAlmostEqual(u.lat, 37.802118, places=5)
        self.assertAlmostEqual(u.lon, -122.341618, places=5)
        self.assertEqual((u.sog, u.cog, u.heading, u.ais_class), (0.0, 219.3, 1, "A"))

    def test_class_a_position_and_not_available_values(self):
        u = self.asm.feed(T1)
        self.assertEqual((u.mmsi, u.lat, u.lon, u.sog, u.cog, u.heading, u.nav_status), (259000420, 60.3913, 5.3221, 12.3, 187.5, 185, 0))
        moored = self.asm.feed(T3_MOORED)
        self.assertEqual((moored.nav_status, moored.cog, moored.heading), (5, None, None))  # 3600 and 511 mean "not available"
        self.assertEqual(ais_nmea.nav_status_text(5), "Moored")

    def test_multipart_static_name_and_type_only(self):
        self.assertIsNone(self.asm.feed(T5[0]))
        u = self.asm.feed(T5[1])
        self.assertEqual((u.msg_type, u.mmsi, u.name, u.ship_type), (5, 259000420, "NORDIC TEST", 70))
        self.assertFalse(u.has_position)
        self.assertFalse(hasattr(u, "callsign") or hasattr(u, "destination") or hasattr(u, "imo"))
        self.assertEqual(ais_nmea.ship_type_text(70), "Cargo")

    def test_class_b_position_and_static_parts(self):
        u = self.asm.feed(T18)
        self.assertEqual((u.msg_type, u.ais_class, u.mmsi, u.lat, u.lon, u.sog, u.cog, u.heading), (18, "B", 257999000, 60.35, 5.25, 6.4, 90.0, 88))
        self.assertEqual(self.asm.feed(T24A).name, "SEA BREEZE")
        part_b = self.asm.feed(T24B)
        self.assertEqual((part_b.ship_type, part_b.name), (37, None))
        self.assertEqual(ais_nmea.ship_type_text(37), "Pleasure craft")

    def test_tag_block_provider_time(self):
        u = self.asm.feed(tagged(T1, 1698764400))
        self.assertEqual(u.provider_time, 1698764400.0)
        bad_tag = "\\s:1,c:1698764400*00\\" + T1
        self.assertIsNone(self.asm.feed(bad_tag))

    def test_rejects_bad_checksum_garbage_and_long_lines(self):
        before = self.asm.rejected
        self.assertIsNone(self.asm.feed(T1[:-2] + "00"))
        self.assertIsNone(self.asm.feed("$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47"))
        self.assertIsNone(self.asm.feed(b"!" + b"A" * 2000))
        self.assertIsNone(self.asm.feed(b"\xff\xfe"))
        self.assertEqual(self.asm.rejected, before + 4)

    def test_orphan_and_expired_fragments_are_bounded(self):
        now = [0.0]
        asm = ais_nmea.AivdmAssembler(clock=lambda: now[0])
        self.assertIsNone(asm.feed(T5[1]))  # second part without first
        self.assertEqual(asm.pending, {})
        asm.feed(T5[0])
        now[0] = ais_nmea.FRAGMENT_TTL_SECONDS + 1
        self.assertIsNone(asm.feed(T5[1]))  # first part expired
        for seq in range(ais_nmea.MAX_PENDING_GROUPS + 20):
            body = f"AIVDM,2,1,{seq % 10},{'AB'[seq % 2]}{seq},53o08I02HUWtiQU`000pu8@T>1@E=@0000000016<PD5:000000QDQiCP000,0"
            asm.feed(f"!{body}*{ais_nmea.nmea_checksum(body)}")
        self.assertLessEqual(len(asm.pending), ais_nmea.MAX_PENDING_GROUPS)

    def test_unsupported_type_returns_none(self):
        body = "AIVDM,1,1,,A,402R3WiuHkRUUo`IqfP03a700<0E,0"  # type 4 base station report
        self.assertIsNone(self.asm.feed(f"!{body}*{ais_nmea.nmea_checksum(body)}"))


if __name__ == "__main__":
    unittest.main()
