from yap_field_map import build_full_field_mapping


def test_full_mapping_includes_man_mac_materiali():
    m = {
        "contexts": ["officina", "carrozzeria"],
        "anagrafica": {"targa": "AB123CD", "cliente_nome": "Test"},
        "agenda": {"data": "2026-05-25", "ora": "10:00", "durata_minuti": 20, "tipo_pratica": "preventivo"},
        "lavorazioni": [
            {"reparto": "officina", "descrizioni": ["Tagliando"], "ore_man": 2, "ricambi": [{"name": "Olio", "quantity": "1"}]},
            {
                "reparto": "carrozzeria",
                "descrizioni": ["Vernice"],
                "ore_mac": 3,
                "materiali_euro": 150,
                "smaltimento_applica": True,
                "smaltimento_percentuale": 2,
            },
        ],
    }
    fm = build_full_field_mapping(m)
    paths = [r["giorgio"] for r in fm["agenda"]]
    assert "practice.appointment_time" in paths
    off = next(x for x in fm["lavorazioni"] if x["reparto"] == "officina")
    car = next(x for x in fm["lavorazioni"] if x["reparto"] == "carrozzeria")
    off_man = next(f for f in off["fields"] if "man_hours" in f["giorgio"])
    car_mac = next(f for f in car["fields"] if "mac_hours" in f["giorgio"])
    assert "MANODOPERA" in off_man["yapPath"]
    assert "MAC" in car_mac["yapPath"] or "macchina" in car_mac["yapPath"]
    assert off_man["writer"] == "giorgio_worker_planned"
    assert fm.get("ordiniDiLavoro")
    assert fm.get("mappingNote")
