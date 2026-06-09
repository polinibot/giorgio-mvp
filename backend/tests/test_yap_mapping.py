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
    # Il Cosa per revisione pura deve essere la TARGA (per agganciare il veicolo).
    assert pick_cosa(m) == "EL733YJ"
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
    assert preview["proposedYap"]["odl"]["pageLabel"] == "Ordini di lavoro"
    assert preview["proposedYap"]["odl"]["yapMenu"]


def test_preview_skips_odl_for_revisione_pura():
    m = _mapping(["revisione"], "EL733YJ", [{"reparto": "revisione", "descrizioni": ["Revisione periodica"]}])
    preview = build_yap_preview(m)
    assert preview["proposedYap"]["delegatedToYap"] == ["gestione_pratica"]
    assert preview["proposedYap"]["odl"] is None


def test_preview_uses_preventivi_page_for_work_preview():
    m = _mapping(
        ["carrozzeria"],
        "GA019BC",
        [{"reparto": "carrozzeria", "descrizioni": ["Verniciatura cerchi"]}],
        tipo="preventivo",
    )
    preview = build_yap_preview(m)
    assert preview["proposedYap"]["delegatedToYap"] == ["gestione_pratica", "odl_base"]
    assert preview["proposedYap"]["odl"]["page"] == "preventivi"
    assert preview["proposedYap"]["odl"]["pageLabel"] == "Preventivi"


def test_preview_normalizes_time_to_yap_slot():
    m = _mapping(["officina"], "AB123CD", [{"reparto": "officina", "descrizioni": ["Controllo"]}])
    m["agenda"]["ora"] = "09:24"
    preview = build_yap_preview(m)
    assert preview["proposedYap"]["popup"]["dalle"] == "09.20"
    assert preview["proposedYap"]["popup"]["alle"] == "09.40"
    assert to_yap_time("09:24") == "09.20"


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
