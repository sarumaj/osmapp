"""_locality_candidates.

This is the one piece of the reverse lookup that makes a judgement rather than
forwarding bytes: it decides which rungs of Nominatim's address hierarchy can
go in the print dialog's "Locality" field, and in what order. Everything around
it — the rate limiter, the cache, the HTTP shape — is shared with the two
routes that already existed.

Both failures here are quiet ones. Widening the key list puts a country in an
autocomplete list of villages; narrowing it leaves a rural territory with no
suggestion at all, which is the case the whole feature exists for.
"""

from typing import Any

from osmapp.internal.geocode import (
    _locality_candidates as locality_candidates,  # type: ignore[reportPrivateUsage]
)


def values(address: dict[str, Any]) -> list[str]:
    return [item["value"] for item in locality_candidates(address)]


def test_the_settlement_comes_before_the_administration_containing_it():
    """A card says which village you are walking, not which county."""
    address = {
        "county": "Powiat pruszkowski",
        "village": "Wólka",
        "municipality": "gmina Michałowice",
    }
    assert values(address) == ["Wólka", "gmina Michałowice", "Powiat pruszkowski"]


def test_a_city_outranks_its_own_district():
    address = {"city_district": "Gonsenheim", "city": "Mainz"}
    assert values(address) == ["Mainz", "Gonsenheim"]


def test_a_name_repeated_across_rungs_is_offered_once():
    """A town that is also its own municipality is one name, not two.

    Nominatim does this routinely, and two identical entries in a dropdown read
    as a bug in the app rather than as a fact about administrative geography.
    """
    address = {"town": "Budenheim", "municipality": "Budenheim"}
    assert values(address) == ["Budenheim"]

    kinds = [item["kind"] for item in locality_candidates(address)]
    assert kinds == ["town"]  # the more specific rung keeps the entry


def test_matching_is_case_insensitive():
    address = {"village": "Wólka", "municipality": "wólka"}
    assert values(address) == ["Wólka"]


def test_everything_outside_the_settlement_hierarchy_is_dropped():
    """House numbers, roads, states and countries are not localities."""
    address = {
        "house_number": "12",
        "road": "Hauptstraße",
        "postcode": "55257",
        "state": "Rheinland-Pfalz",
        "country": "Deutschland",
        "ISO3166-2-lvl4": "DE-RP",
    }
    assert values(address) == []


def test_blank_and_non_string_values_are_dropped():
    """addressdetails is JSON from another service; it is not trusted to be text."""
    address: dict[str, Any] = {
        "city": "   ",
        "town": None,
        "village": 42,
        "hamlet": "Layenhof",
    }
    assert values(address) == ["Layenhof"]


def test_an_empty_address_is_an_empty_list():
    assert locality_candidates({}) == []
