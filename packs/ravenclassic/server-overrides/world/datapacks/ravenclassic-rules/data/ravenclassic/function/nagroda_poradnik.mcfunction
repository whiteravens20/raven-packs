# Nagroda za przeczytanie całego poradnika.
#
# Wołane przez `rewards` osiągnięcia ravenclassic:poradnik, a nie wprost z
# książki. To celowe: osiągnięcie przechodzi w stan zdobyty raz, więc raz
# wypadnie nagroda — nawet gdyby stan „komenda już użyta" po stronie
# Modonomicona kiedyś przepadł. Funkcja biegnie jako gracz, który je zdobył.
#
# Samo kryterium nadaje `commands/nagroda.json` w poradniku, a link do tej
# komendy stoi na stronie widocznej dopiero po odblokowaniu węzła
# ravenclassic:poradnik_przeczytany — czyli po obejrzeniu wszystkich
# czternastu wpisów.
give @s minecraft:diamond_block
tellraw @s {"translate":"ravenclassic.poradnik.nagroda","color":"green"}
