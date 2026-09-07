# Poradnik na pulpicie: czytać wolno, zabrać nie.
#
# Modonomicon przejmuje kliknięcie w pulpit i sam decyduje, co się stanie:
# prawy przycisk otwiera poradnik, shift + prawy zabiera książkę do ekwipunku.
# Jedno i drugie jest dla Open Parties and Claims tą samą interakcją z blokiem,
# więc wpis "minecraft:lectern" w forcedBlockProtectionExceptionList otwiera obie
# naraz — zmierzone na żywym serwerze, tak samo z prefiksem "anything$" i tak
# samo po ustawieniu grupy Lecterns w configu działek serwerowych. OPAC nie umie
# tego rozdzielić, a Classic nie ma KubeJS, którym Forge zamyka to od środka.
#
# Więc książki się nie broni — odkłada się ją z powrotem. Gracz, który ją zabrał,
# zostaje z egzemplarzem, ale zestaw startowy i tak daje poradnik każdemu, więc
# to kopia czegoś, co już ma. Pulpit jest znowu pełny w ciągu sekundy.
#
# Znacznik stoi DOKŁADNIE w bloku pulpitu:
#   /summon minecraft:marker ~ ~ ~ {Tags:["rc_pulpit"]}
# stojąc na pulpicie i celując w niego. Znaczników może być wiele.
#
# Cztery linijki zamiast jednej, bo setblock nie zna stanu, który zastępuje:
# pominięta właściwość wraca do wartości domyślnej, więc pulpit obrócony na
# wschód wstałby zwrócony na północ. Kierunek trzeba przepisać wprost.
execute as @e[type=minecraft:marker,tag=rc_pulpit] at @s if block ~ ~ ~ minecraft:lectern[has_book=false,facing=north] run setblock ~ ~ ~ minecraft:lectern[facing=north,has_book=true,powered=false]{Book:{count:1,id:"modonomicon:modonomicon",components:{"modonomicon:book_id":"ravenclassic:przewodnik"}},Page:0}
execute as @e[type=minecraft:marker,tag=rc_pulpit] at @s if block ~ ~ ~ minecraft:lectern[has_book=false,facing=south] run setblock ~ ~ ~ minecraft:lectern[facing=south,has_book=true,powered=false]{Book:{count:1,id:"modonomicon:modonomicon",components:{"modonomicon:book_id":"ravenclassic:przewodnik"}},Page:0}
execute as @e[type=minecraft:marker,tag=rc_pulpit] at @s if block ~ ~ ~ minecraft:lectern[has_book=false,facing=west] run setblock ~ ~ ~ minecraft:lectern[facing=west,has_book=true,powered=false]{Book:{count:1,id:"modonomicon:modonomicon",components:{"modonomicon:book_id":"ravenclassic:przewodnik"}},Page:0}
execute as @e[type=minecraft:marker,tag=rc_pulpit] at @s if block ~ ~ ~ minecraft:lectern[has_book=false,facing=east] run setblock ~ ~ ~ minecraft:lectern[facing=east,has_book=true,powered=false]{Book:{count:1,id:"modonomicon:modonomicon",components:{"modonomicon:book_id":"ravenclassic:przewodnik"}},Page:0}
