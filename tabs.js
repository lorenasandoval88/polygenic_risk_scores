

function tabFunction(evt, openTab, subTab) {
    var i, tabcontent, tablinks;
    tabcontent = document.getElementsByClassName("tabcontent");
    for (i = 0; i < tabcontent.length; i++) {
        tabcontent[i].style.display = "none";
    }
    tablinks = document.getElementsByClassName("tablinks");

    for (i = 0; i < tablinks.length; i++) {
        tablinks[i].className = tablinks[i].className.replace(" active", "");
    }
    if(subTab) {
      var parent = evt.currentTarget.closest('.tabcontent');
      parent.style.display = "block";
      parent.className += " active";
    }
    document.getElementById(openTab).style.display = "block";
    evt.currentTarget.className += " active";

}
