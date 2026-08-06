# Uruchamiane przy starcie serwera i po każdym /reload.

# deathCount rośnie sam przy każdej śmierci gracza — nie trzeba go dotykać.
scoreboard objectives add rc_deaths deathCount
# Cel typu "trigger" to jedyny sposób, żeby zwykły gracz odpalił funkcję
# datapacka bez żadnych uprawnień. Gracz woła /trigger rc_kit.
scoreboard objectives add rc_kit trigger
# Sekundy pozostałe do następnego użycia /trigger rc_kit.
scoreboard objectives add rc_cd dummy

# Pętla chodzi raz na sekundę, nie 20 razy — tu nie ma nic, co wymaga ticku.
schedule function ravenclassic:tick 1s replace
