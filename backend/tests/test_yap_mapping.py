"""Test regole mapping Giorgio → YAP (contesti mini-app)."""

from yap_mapping import pick_cosa, pick_yap_tags, build_yap_preview, to_yap_time


def _mapping(contexts, targa, lavorazioni, tipo="ordine_di_lavoro"):
    return {
        "contexts": contexts,
        "anagrafica": {"targa": targa},
        "agenda": {"data": "2026-05-25", "ora": "10:00", "durata_minuti": 20, "tipo_pratica": tipo},
        "lavorazioni": lavorazioni,
    }


def test_revisione_pura():
    m = _mapping(["revisione"], "EL733YJ", [{"reparto": "revisione", "descrizioni": ["Revisione periodica"]}])
    assert pick_cosa(m) == "REVISIONE"
    assert pick_yap_tags(m) == ["revisione"]


def test_officina_revisione_fd897lp_style():
    m = _mapping(
        ["officina", "revisione"],
        "FD897LP",
        [
            {"reparto": "officina", "descrizioni": ["RIPARARE FORATURA", "Revisione"]},
            {"reparto": "revisione", "descrizioni": ["Revisione"]},
        ],
    )
    assert pick_yap_tags(m) == ["officina", "revisione"]
    assert pick_cosa(m) == "FD897LP - RIPARARE FORATURA"


def test_carrozzeria_tags_only_from_context_not_text():
    m = _mapping(
        ["carrozzeria"],
        "GA019BC",
        [{"reparto": "carrozzeria", "descrizioni": ["Verniciatura cerchi", "revisione"]}],
        tipo="preventivo",
    )
    assert pick_yap_tags(m) == ["pneumatici", "preventivo"]
    assert pick_cosa(m) == "GA019BC - VERNICIATURA CERCHI"


def test_build_preview_has_odl_block():
    m = _mapping(["officina"], "AB123CD", [{"reparto": "officina", "descrizioni": ["Controllo"]}])
    preview = build_yap_preview(m)
    assert preview["proposedYap"]["popup"]["cosa"] == "AB123CD - CONTROLLO"
    assert preview["proposedYap"]["odl"]["action"] == "mapping_complete_worker_planned"
    assert preview["proposedYap"]["odl"]["yapMenu"]


def test_preview_normalizes_time_to_yap_slot():
    m = _mapping(["officina"], "AB123CD", [{"reparto": "officina", "descrizioni": ["Controllo"]}])
    m["agenda"]["ora"] = "07:15"
    preview = build_yap_preview(m)
    assert preview["proposedYap"]["popup"]["dalle"] == "07.20"
    assert preview["proposedYap"]["popup"]["alle"] == "07.40"
    assert to_yap_time("07:15") == "07.20"


def test_cosa_priority_officina_over_revisione():
    """Ordine lavorazioni in payload non deve vincere: vince officina."""
    m = _mapping(
        ["officina", "carrozzeria", "revisione"],
        "TRIPLE01",
        [
            {"reparto": "revisione", "descrizioni": ["Revisione periodica"]},
            {"reparto": "carrozzeria", "descrizioni": ["Verniciatura"]},
            {"reparto": "officina", "descrizioni": ["Tagliando"]},
        ],
    )
    assert pick_cosa(m) == "TRIPLE01 - TAGLIANDO"


def test_odl_includes_section_note():
    m = _mapping(
        ["officina"],
        "AB123CD",
        [{"reparto": "officina", "descrizioni": ["Controllo"], "note": "Cliente urgente"}],
    )
    m["note_interne"] = "Nota pratica"
    preview = build_yap_preview(m)
    lav = preview["proposedYap"]["odl"]["lavorazioniGiorgio"][0]
    assert lav["noteReparto"] == "Cliente urgente"
