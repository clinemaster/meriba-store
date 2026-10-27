"""Upload Received Stock: a workbook of deliveries is previewed, then added to stock as ordinary stock receipts."""
import io
from decimal import Decimal

import openpyxl
import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from catalog.models import ProductUnit
from core.models import AuditLog
from finance import receipt_import
from finance.models import GoodsReceipt, ReceiptImport
from inventory.models import InventoryMovement
from sales.models import Sale

from .conftest import client_for, stock_of

HEADINGS = ["S/N", "Details", "Counted by or Unit", "Volume (ml)", "Quantity received"]
URL = "/api/v1/stock/receipt-imports/"


def workbook(rows, headings=HEADINGS, title_rows=0) -> bytes:
    book = openpyxl.Workbook()
    sheet = book.active
    for _ in range(title_rows):
        sheet.append(["MERIBA deliveries"])
    sheet.append(headings)
    for row in rows:
        sheet.append(row)
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def upload(client, data, name="delivery.xlsx"):
    return client.post(URL, {"file": SimpleUploadedFile(name, data)}, format="multipart")


def confirm(client, batch, **body):
    return client.post(f"{URL}{batch}/confirm/", body, format="json")


def review(client, batch, **body):
    """Save the Owner's corrections (edits by Excel row) and combine/separate decisions; returns the new preview."""
    response = client.post(f"{URL}{batch}/", body, format="json")
    assert response.status_code == 200, response.data
    return response.data


def by_row(preview):
    return {r["row"]: r for r in preview["rows"]}


@pytest.fixture
def shelf(make_product):
    """Konyagi by the bottle; Castle counted in bottles with a verified crate of 12; two Savanna sizes."""
    konyagi = make_product("Konyagi ndogo", "4500", 100, volume_ml=200)
    castle = make_product("Castle lager", "3000", 50, volume_ml=500)
    ProductUnit.objects.create(product=castle, name="Crate", factor=Decimal("12"), selling_price=Decimal("34000"), is_verified=True)
    small = make_product("Savanna", "5000", 10, volume_ml=330)
    big = make_product("Savanna", "9000", 5, volume_ml=750)
    return konyagi, castle, small, big


def test_template_has_the_five_headings(owner, cashier):
    response = client_for(owner).get(f"{URL}template/")
    assert response.status_code == 200 and "spreadsheetml" in response["Content-Type"]
    sheet = openpyxl.load_workbook(io.BytesIO(response.content)).active
    assert [c.value for c in sheet[1]] == HEADINGS
    assert client_for(cashier).get(f"{URL}template/").status_code == 403


def test_missing_or_misordered_columns_are_refused_before_anything_is_read(owner):
    client = client_for(owner)
    missing = upload(client, workbook([[1, "Konyagi ndogo", "Bottle", 24]], headings=["S/N", "Details", "Unit", "Quantity received"]))
    assert missing.status_code == 400 and missing.data["code"] == "bad_columns"
    assert "Volume (ml)" in missing.data["message"]
    shuffled = upload(client, workbook([], headings=["S/N", "Details", "Volume (ml)", "Counted by or Unit", "Quantity received"]))
    assert shuffled.status_code == 400 and "order" in shuffled.data["message"]
    assert upload(client, b"not excel", name="x.xls").data["code"] == "bad_file"
    assert not ReceiptImport.objects.exists()


def test_upload_over_size_limit_is_rejected_before_import(owner):
    response = upload(client_for(owner), b"x" * (receipt_import.MAX_BYTES + 1))

    assert response.status_code == 400 and response.data["code"] == "too_large"
    assert not ReceiptImport.objects.exists()


def test_preview_matches_converts_and_flags_without_touching_stock(owner, shelf, make_product):
    konyagi, castle, small, big = shelf
    off = make_product("Old gin", "1000", 0, is_active=False)
    data = workbook([
        [1, "  KONYAGI   ndogo ", "bottles", 200, 24],    # row 2: name ignores case and spaces
        [2, "Castle lager", "Crate", "500ml", 2],         # row 3: 2 crates of 12 = 24 bottles
        [3, "Savanna", "Bottle", 750, 6],                  # row 4: two Savannas, the volume picks the 750
        [4, "Savanna", "Bottle", "", 3],                   # row 5: cannot tell which Savanna
        [5, "Konyagi ndogo", "Carton", 200, 1],            # row 6: no verified carton for Konyagi
        [6, "Castle lager", "Bottle", 330, 5],             # row 7: wrong volume
        [7, "Konyagi kubwa", "Bottle", 750, 5],            # row 8: no such product
        [8, "Old gin", "Bottle", "", 5],                   # row 9: switched off
        [9, "Castle lager", "Bottle", "", "2.5"],          # row 10: not whole
        [10, "Konyagi ndogo", "Glass", "", 1],             # row 11: not a shop unit
        ["", "TOTAL", "", "", 46],                         # row 12
    ], title_rows=1)
    response = upload(client_for(owner), data)
    assert response.status_code == 201, response.data
    preview = response.data
    rows = by_row(preview)
    assert (rows[3]["status"], rows[3]["product"]["id"], rows[3]["adds"], rows[3]["stock_before"], rows[3]["stock_after"]) == (
        "READY", konyagi.pk, "24", "100", "124")
    assert (rows[4]["status"], rows[4]["product"]["id"], rows[4]["adds"], rows[4]["stock_after"]) == ("READY", castle.pk, "24", "74")
    assert (rows[5]["status"], rows[5]["product"]["id"]) == ("READY", big.pk)
    assert rows[6]["status"] == "AMBIGUOUS" and {c["id"] for c in rows[6]["candidates"]} == {small.pk, big.pk}
    assert rows[7]["status"] == "INVALID" and "not by the carton" in rows[7]["problems"][0]["problem"]
    assert rows[8]["status"] == "INVALID" and "330 ml" in rows[8]["problems"][0]["problem"]
    assert rows[9]["status"] == "UNMATCHED" and rows[9]["problems"][0]["fix"]
    assert rows[10]["status"] == "INVALID" and "switched off" in rows[10]["problems"][0]["problem"]
    assert rows[11]["status"] == "INVALID" and "whole number" in rows[11]["problems"][0]["problem"]
    assert rows[12]["status"] == "INVALID" and "'Glass'" in rows[12]["problems"][0]["problem"]
    assert rows[13]["status"] == "SKIPPED"
    assert preview["counts"] == {"READY": 3, "UNMATCHED": 1, "AMBIGUOUS": 1, "INVALID": 5, "SKIPPED": 1, "EXCLUDED": 0}
    assert (preview["summary"]["needs_review"], preview["summary"]["unmatched"], preview["summary"]["can_confirm"]) == (6, 1, False)
    assert rows[6]["match_status"] == "NEEDS_REVIEW" and rows[9]["match_status"] == "UNMATCHED"
    assert rows[5]["match_status"] == "MATCHED" and rows[3]["match_status"] == "DUPLICATE"  # Konyagi is also on rows 7 and 12
    # sorted by the products' S/No, unmatched rows last; the Excel row number is kept on each
    matched = [r["product"]["serial_number"] for r in preview["rows"] if r["product"]]
    assert matched == sorted(matched) and preview["rows"][-1]["product"] is None
    # nothing has changed yet
    assert (stock_of(konyagi), stock_of(castle)) == (100, 50)
    assert not GoodsReceipt.objects.exists() and ReceiptImport.objects.get().status == "PREVIEW"


def test_confirm_adds_received_quantities_as_stock_receipts(owner, shelf):
    konyagi, castle, small, big = shelf
    preview = upload(client_for(owner), workbook([
        [1, "Konyagi ndogo", "Bottle", 200, 24], [2, "Castle lager", "Crate", 500, 2], [3, "Savanna", "Bottle", "", 3],
        [4, "Nobody knows", "Bottle", "", 1],
    ])).data
    # the Savanna row needs a choice, and the unknown product must be corrected or excluded before anything is added
    rechecked = review(client_for(owner), preview["batch"], edits={"4": {"product": small.pk}})
    assert by_row(rechecked)[4]["status"] == "READY"
    blocked = confirm(client_for(owner), preview["batch"])
    assert blocked.status_code == 400 and blocked.data["code"] == "unresolved_rows" and "5" in blocked.data["message"]
    assert stock_of(konyagi) == 100
    review(client_for(owner), preview["batch"], edits={"4": {"product": small.pk}, "5": {"excluded": True}})

    response = confirm(client_for(owner), preview["batch"], reference="INV-77")
    assert response.status_code == 201, response.data
    result = response.data["result"]
    assert (result["rows_added"], result["products_updated"], [s["row"] for s in result["skipped"]]) == (3, 3, [5])
    assert (stock_of(konyagi), stock_of(castle), stock_of(small), stock_of(big)) == (124, 74, 13, 5)  # 100+24, 50+2x12, 10+3

    receipt = GoodsReceipt.objects.get()
    assert receipt.reference == "INV-77" and "delivery.xlsx" in receipt.note and receipt.received_by == owner
    assert {(line.product_id, line.quantity, line.unit_cost) for line in receipt.lines.all()} == {
        (konyagi.pk, 24, Decimal("1000")), (castle.pk, 24, Decimal("1000")), (small.pk, 3, Decimal("1000"))}  # the product's purchase price
    assert InventoryMovement.objects.filter(movement_type="RECEIPT").count() == 3
    assert not Sale.objects.exists()  # received stock is never a sale
    log = AuditLog.objects.get(action="stock.receipt_imported")
    assert log.after["file"] == "delivery.xlsx" and log.after["receipts"] == [receipt.pk] and log.actor == owner

    # pressing confirm again changes nothing
    again = confirm(client_for(owner), preview["batch"])
    assert again.status_code == 200 and again.data["created"] is False and stock_of(konyagi) == 124


def test_duplicate_rows_wait_for_the_owner_to_combine_or_separate(owner, shelf):
    konyagi, castle, *_ = shelf
    client = client_for(owner)
    rows = [[1, "Konyagi ndogo", "Bottle", "", 10], [2, "Castle lager", "Bottle", "", 5], [3, "Konyagi ndogo", "Bottle", "", 4]]
    preview = upload(client, workbook(rows)).data
    assert preview["duplicates"] == [{"product": konyagi.pk, "label": "Konyagi ndogo", "rows": [2, 4], "ready_rows": [2, 4], "total": "14",
                                     "decision": None}]
    assert by_row(preview)[2]["duplicate"] and by_row(preview)[4]["duplicate"] and not by_row(preview)[3]["duplicate"]
    undecided = confirm(client, preview["batch"])
    assert undecided.status_code == 400 and undecided.data["code"] == "duplicates_undecided" and stock_of(konyagi) == 100

    review(client, preview["batch"], decisions={str(konyagi.pk): "separate"})
    done = confirm(client, preview["batch"])
    assert done.status_code == 201
    first, second = GoodsReceipt.objects.order_by("id")
    assert {(l.product_id, l.quantity) for l in first.lines.all()} == {(konyagi.pk, 10), (castle.pk, 5)}
    assert {(l.product_id, l.quantity) for l in second.lines.all()} == {(konyagi.pk, 4)}
    assert stock_of(konyagi) == 114

    combined = upload(client, workbook(rows + [[4, "Castle lager", "Bottle", "", 1]])).data
    review(client, combined["batch"], decisions={str(konyagi.pk): "combine", str(castle.pk): "combine"})
    confirm(client, combined["batch"])
    newest = GoodsReceipt.objects.order_by("-id").first()
    assert {(l.product_id, l.quantity) for l in newest.lines.all()} == {(konyagi.pk, 14), (castle.pk, 6)}


def test_the_same_file_cannot_add_stock_twice_by_accident(owner, shelf):
    konyagi, *_ = shelf
    data = workbook([[1, "Konyagi ndogo", "Bottle", "", 24]])
    first = upload(client_for(owner), data).data
    confirm(client_for(owner), first["batch"])
    assert stock_of(konyagi) == 124

    second = upload(client_for(owner), data, name="renamed.xlsx").data
    assert second["already_imported"]["batch"] == first["batch"]
    refused = confirm(client_for(owner), second["batch"])
    assert refused.status_code == 400 and refused.data["code"] == "already_imported" and stock_of(konyagi) == 124
    no_reason = confirm(client_for(owner), second["batch"], reimport_reason="again")
    assert no_reason.status_code == 400 and stock_of(konyagi) == 124
    allowed = confirm(client_for(owner), second["batch"], reimport_reason="Supplier delivered the same list twice")
    assert allowed.status_code == 201 and stock_of(konyagi) == 148
    assert AuditLog.objects.get(action="stock.receipt_import_reprocessed").reason == "Supplier delivered the same list twice"


def test_a_failure_part_way_leaves_stock_untouched(owner, shelf, monkeypatch):
    konyagi, castle, *_ = shelf
    preview = upload(client_for(owner), workbook([[1, "Konyagi ndogo", "Bottle", "", 10], [2, "Konyagi ndogo", "Bottle", "", 4],
                                                 [3, "Castle lager", "Bottle", "", 5]])).data
    real = receipt_import.receive_stock
    calls = []

    def fail_on_second(**kwargs):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("power cut")
        return real(**kwargs)

    review(client_for(owner), preview["batch"], decisions={str(konyagi.pk): "separate"})
    monkeypatch.setattr(receipt_import, "receive_stock", fail_on_second)
    with pytest.raises(RuntimeError):
        receipt_import.confirm(batch_id=preview["batch"], user=owner)
    assert (stock_of(konyagi), stock_of(castle)) == (100, 50)
    assert not GoodsReceipt.objects.exists() and ReceiptImport.objects.get().status == "PREVIEW"


@pytest.mark.parametrize("role", ["accountant", "cashier"])
def test_only_the_owner_can_upload_check_or_confirm(role, request, owner, shelf):
    """Owner's decision, 21 Oct 2026. The Accountant still receives deliveries by typing them on Receive Stock."""
    konyagi, *_ = shelf
    other = client_for(request.getfixturevalue(role))
    data = workbook([[1, "Konyagi ndogo", "Bottle", "", 1]])
    assert upload(other, data).status_code == 403
    assert other.get(f"{URL}template/").status_code == 403
    batch = upload(client_for(owner), data).data["batch"]
    assert other.get(f"{URL}{batch}/").status_code == 403
    assert other.post(f"{URL}{batch}/", {"choices": {}}, format="json").status_code == 403
    assert confirm(other, batch).status_code == 403
    assert stock_of(konyagi) == 100 and not GoodsReceipt.objects.exists()


def test_owner_corrects_rows_and_sees_the_projected_stock_before_anything_changes(owner, shelf):
    konyagi, castle, small, big = shelf
    client = client_for(owner)
    preview = upload(client, workbook([
        [1, "Konyagi ndogo", "Bottle", 200, 24],   # row 2: matched, but it was really Castle that came in
        [2, "Castle lager", "Carton", "", 2],      # row 3: no carton for Castle; it was 2 crates
        [3, "Castle lager", "Bottle", "", "x"],    # row 4: quantity unreadable; it was 6
        [4, "Snacks", "Pack", "", 3],              # row 5: not a product the shop sells
    ])).data
    assert preview["summary"]["can_confirm"] is False

    batch = preview["batch"]
    corrected = review(client, batch, edits={
        "2": {"product": castle.pk, "volume": ""},  # the file's 200 ml was Konyagi's; cleared with the product
        "3": {"unit": "Crate"}, "4": {"quantity": "6"}, "5": {"excluded": True}})
    rows = by_row(corrected)
    assert rows[2]["chosen"] and rows[2]["name_differs"] and rows[2]["product"]["id"] == castle.pk
    assert (rows[3]["status"], rows[3]["adds"], rows[3]["edited"], rows[3]["uploaded"]["unit"]) == ("READY", "24", ["unit"], "Carton")
    assert (rows[4]["status"], rows[4]["adds"]) == ("READY", "6")
    assert (rows[5]["status"], rows[5]["match_status"]) == ("EXCLUDED", "EXCLUDED")
    # Castle: 50 now, + 24 (row 2) + 24 (2 crates of 12, row 3) + 6 (row 4) = 104, shown on each of its rows
    assert {rows[n]["stock_after"] for n in (2, 3, 4)} == {"104"}
    summary = corrected["summary"]
    assert (summary["total_rows"], summary["matched"], summary["duplicate_rows"], summary["ready"], summary["excluded"]) == (4, 3, 3, 3, 1)
    assert summary["received_by_unit"] == [{"unit": "Bottle", "quantity": "54"}]
    assert summary["can_confirm"] is False and summary["undecided_duplicates"] == 1  # Castle is on three rows
    assert stock_of(castle) == 50  # reviewing never changes stock

    # the corrections are kept on the upload, so the preview can be left and opened again
    again = client.get(f"{URL}{batch}/").data
    assert again["edits"]["3"] == {"unit": "Crate"} and again["summary"]["ready"] == 3

    ready = review(client, batch, decisions={str(castle.pk): "combine"})
    assert ready["summary"]["can_confirm"] is True
    assert confirm(client, batch).status_code == 201
    assert (stock_of(castle), stock_of(konyagi)) == (104, 100)
    log = AuditLog.objects.get(action="stock.receipt_imported")
    assert log.after["excluded_rows"] == [5] and log.after["corrections"]["4"] == {"quantity": "6"}
    assert client.post(f"{URL}{batch}/", {"edits": {}}, format="json").status_code == 409  # imported: no more changes


def test_units_are_never_added_together_in_the_totals(owner, make_product):
    make_product("Beer crate", "30000", 5, base_unit="Crate")
    make_product("Wine", "15000", 5)
    preview = upload(client_for(owner), workbook([[1, "Beer crate", "Crate", "", 4], [2, "Wine", "Bottle", "", 12]])).data
    assert preview["summary"]["received_by_unit"] == [{"unit": "Bottle", "quantity": "12"}, {"unit": "Crate", "quantity": "4"}]
    assert client_for(owner).post(f"{URL}{preview['batch']}/", {"edits": {"99": {"excluded": True}}}, format="json").status_code == 400


def test_the_products_own_pack_is_read_in_its_own_unit(owner, make_product):
    """Owner's decision, 21 Oct 2026: a file may give the pack recorded on the product (its Excel "pack" column) as the
    unit. "20 BOX(24)" for a product counted in bottles is 20 bottles; "20 Box (4)" for one counted in packs is 20 packs."""
    bavaria = make_product("Bavaria", stock=20, pack_description="BOX(24)")
    windhock = make_product("Windhock", stock=10, base_unit="Pack", pack_description="Box (4)")
    flying = make_product("Flying Fish", stock=100, base_unit="Crate")
    konyagi = make_product("Konyagi ndogo", stock=600)  # no pack recorded
    castle = make_product("Castle lager", stock=50)
    ProductUnit.objects.create(product=castle, name="Box", factor=Decimal("12"), selling_price=Decimal("30000"), is_verified=True)
    preview = upload(client_for(owner), workbook([
        [1, "Bavaria", "Box (24)", "", 20],         # row 2: same pack, other spacing and capitals
        [2, "Windhock", "Box (4)", "", 20],         # row 3
        [3, "Flying Fish", "CRET", "", 20],         # row 4: the workbook's spelling of crate
        [4, "Konyagi ndogo", "Box (24)", "", 20],   # row 5: no pack recorded, no box package: cannot tell
        [5, "Castle lager", "Box (12)", "", 2],     # row 6: the verified box of 12
        [6, "Castle lager", "Box (24)", "", 1],     # row 7: says 24 a box, but the verified box holds 12
    ])).data
    rows = by_row(preview)
    assert (rows[2]["status"], rows[2]["adds"], rows[2]["stock_after"], rows[2]["unit_name"]) == ("READY", "20", "40", "Bottle")
    assert "how Bavaria is packed" in rows[2]["notes"][-1]
    assert (rows[3]["status"], rows[3]["adds"], rows[3]["unit_name"]) == ("READY", "20", "Pack")
    assert (rows[4]["status"], rows[4]["adds"], rows[4]["unit_name"]) == ("READY", "20", "Crate")
    assert rows[5]["status"] == "INVALID" and "no pack recorded" in rows[5]["problems"][0]["problem"]
    assert "Bottle" in rows[5]["problems"][0]["fix"]
    assert (rows[6]["status"], rows[6]["adds"], rows[6]["factor"]) == ("READY", "24", "12")  # 2 verified boxes of 12
    assert rows[7]["status"] == "INVALID" and "holds 12" in rows[7]["problems"][0]["problem"]
    assert (stock_of(bavaria), stock_of(windhock), stock_of(flying), stock_of(konyagi)) == (20, 10, 100, 600)


def test_short_size_words_match_only_when_nothing_has_the_exact_name(owner, make_product):
    """'ndogo' = 'ndg', 'kubwa' = 'kb'/'k', 'kati' = 'kat', in the last word only. The rest of the name must be the same."""
    amarula = make_product("Amarula ndg", stock=5, volume_ml=200)
    jack = make_product("JACK Daniel K", stock=5, volume_ml=700)
    exact = make_product("Hennesy kubwa", stock=5, volume_ml=750)
    make_product("Hennesy kb", stock=5, volume_ml=750)  # the exact name above wins over this one
    make_product("Captain kat", stock=5)
    preview = upload(client_for(owner), workbook([
        [1, "Amarula ndogo", "bottle", "200mls", 20],   # row 2
        [2, "jack daniel kubwa", "bottle", 700, 20],    # row 3
        [3, "Hennesy kubwa", "bottle", 750, 20],        # row 4: exact name exists
        [4, "Captain morgan kati", "bottle", "", 20],   # row 5: another word differs: no match
    ])).data
    rows = by_row(preview)
    assert (rows[2]["status"], rows[2]["product"]["id"], rows[2]["name_differs"]) == ("READY", amarula.pk, True)
    assert "size word written short" in " ".join(rows[2]["notes"])
    assert not any("is packed" in n for n in rows[2]["notes"])  # a plain "bottle" needs no pack note
    assert (rows[3]["status"], rows[3]["product"]["id"]) == ("READY", jack.pk)
    assert (rows[4]["product"]["id"], rows[4]["name_differs"]) == (exact.pk, False)
    assert rows[5]["status"] == "UNMATCHED"
